/**
 * AlipayClient — the 8-step `pay402()` state machine (design §5.2.3).
 *
 * The Alipay skill guide §5 forbids skipping any step; each maps to one
 * `alipay-bot` spawn. This class drives them in order and hands the caller a
 * single terminal `AlipayPaymentResult`, so paying via Alipay looks the same
 * as awaiting an EVM settle (design §5.2.3 "关键设计").
 *
 *   0.  ensureCli()                          version gate (≥ MIN_CLI_VERSION)
 *   1b. alipay-bot payment-intent …          session handshake
 *   2.  alipay-bot check-wallet              → NeedsWalletSetupError if unopened
 *   3.  dump Payment-Needed → tmp file        (internal, user-invisible)
 *   4.  alipay-bot 402-buyer-pay -f … -r …   → paymentUrl + tradeNo → onPaymentPending
 *   5.  pollUntil(tradeNo)                    3s poll until paid / rejected / timeout
 *   7.  return resource body
 *   8.  alipay-bot 402-buyer-fulfillment-ack  fire-and-forget
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { X402PaymentRequirements } from '../core/types.js';
import type { CliRunner } from './cli.js';
import { runCli } from './cli.js';
import { ensureCli, type VersionGetter } from './install.js';
import { pollUntil } from './poll.js';
import { AlipayProtocolError, NeedsWalletSetupError } from './errors.js';
import { alipayLog, timeStep } from './log.js';

export interface AlipayPendingInfo {
  paymentUrl: string;
  shortenUrl?: string;
  tradeNo: string;
}

export interface AlipayPayOptions {
  /** The resource URL being paid for (alipay-bot `-r`). */
  resourceUrl: string;
  /** The alipay 402 accepts[] entry (carries extra.payment_needed_header etc.). */
  requirement: X402PaymentRequirements;
  /** Verbatim CLI passthrough (MEDIA: lines are stripped before this is called). */
  onLine?: (line: string) => void;
  /** Surfaced once the payment URL + tradeNo are known (Step 4). */
  onPaymentPending?: (info: AlipayPendingInfo) => void;
  /** Overall budget; defaults to the challenge's pay_before window. */
  timeoutMs?: number;
  /** Cancellation. */
  signal?: AbortSignal;
  /** Non-GET resource verb / body, forwarded to 402-buyer-pay. */
  method?: string;
  data?: string;
  /**
   * One-line payment intent summary (alipay-bot `payment-intent -i`, REQUIRED
   * by the CLI). Defaults to a summary derived from the requirement amount.
   */
  intentSummary?: string;
}

export interface AlipayPaymentResult {
  /** The resource response body, verbatim. */
  body: string;
  payment: { tradeNo: string; outTradeNo?: string };
  /** Any MEDIA: image paths alipay-bot surfaced, stripped from the stream. */
  media: string[];
}

export interface AlipayClientOptions {
  /** Stable session id; falls back to AIPAY_SESSION_ID, then a fresh UUID. */
  sessionId?: string;
  configDir?: string;
  /**
   * Host framework for alipay-bot session-path resolution (claudecode,
   * openclaw, nanobot, …). Defaults to AIPAY_FRAMEWORK, then 'openclaw'.
   * Note: 'moltspay' is NOT a framework alipay-bot recognizes.
   */
  framework?: string;
  /** DI seams for tests. */
  runner?: CliRunner;
  getVersion?: VersionGetter;
  now?: () => number;
  /**
   * Whether check-wallet results may use the process-level cache. Defaults to
   * "only when the default (real-CLI) runner is used", so injected test/DI
   * runners always spawn. Set explicitly to exercise the cache in tests.
   */
  cacheWallet?: boolean;
  /**
   * Whether the payment-intent handshake may be skipped via the process-level
   * cache. Same default as {@link cacheWallet} (only for the default runner).
   */
  cacheIntent?: boolean;
}

const TRADE_NO_RE = /^\d{32}$/;

/**
 * Resolve the session id. The skill guide forbids *fabricating* a session-like
 * string, NOT generating a real UUID — so a crypto UUID is the correct default.
 */
export function resolveSessionId(explicit?: string, envSession?: string): string {
  return explicit ?? envSession ?? randomUUID();
}

/** Skill guide §5 Step 8: tradeNo must be exactly 32 digits. */
export function assertTradeNo(t: string): void {
  if (!TRADE_NO_RE.test(t)) {
    throw new AlipayProtocolError(`invalid tradeNo (expect 32 digits): ${t}`);
  }
}

/** Pull a 32-digit tradeNo from CLI output (bare or `tradeNo: …` / `trade_no=…`). */
export function parseTradeNo(lines: string[]): string | null {
  for (const line of lines) {
    const labeled = line.match(/trade[_-]?no["'\s:=]+(\d{32})/i);
    if (labeled) return labeled[1];
    const bare = line.match(/\b(\d{32})\b/);
    if (bare) return bare[1];
  }
  return null;
}

/** Pull the payment URL (and optional shortened URL) from buyer-pay output. */
export function parsePaymentUrl(lines: string[]): { paymentUrl?: string; shortenUrl?: string } {
  let paymentUrl: string | undefined;
  let shortenUrl: string | undefined;
  for (const line of lines) {
    const m = line.match(/(alipays?:\/\/\S+|https?:\/\/\S+)/i);
    if (!m) continue;
    // alipay-bot prints the link inside markdown `[文字](url)`; the greedy `\S+`
    // swallows the trailing `)` (and any `]`/`` ` ``/`>`), yielding a URL that
    // 404s. Strip those trailing chars.
    const url = m[1].replace(/[)\]`>]+$/, '');
    if (/short|qr\.alipay|surl|\/s\//i.test(line) && !shortenUrl) shortenUrl = url;
    else if (!paymentUrl) paymentUrl = url;
  }
  // A lone URL on a "short" line should still serve as the payment URL.
  if (!paymentUrl && shortenUrl) paymentUrl = shortenUrl;
  return { paymentUrl, shortenUrl };
}

/** Split MEDIA: image-path lines out of the stream (design §5.2.4). */
export function extractMedia(line: string): string | null {
  const m = line.match(/^\s*MEDIA:\s*(.+?)\s*$/);
  return m ? m[1] : null;
}

/**
 * Decide whether check-wallet reports an opened, ready wallet.
 *
 * Observed real output (alipay-bot 0.3.15): a JSON object `{code, message,
 * reason}` — `code: 500, message: "未开通"` when the wallet is NOT opened, and
 * crucially the **process still exits 0**, so the exit code is useless here.
 * We therefore key off `code` (200 = ready) and fall back to textual markers.
 */
export function isWalletReady(lines: string[]): boolean {
  const text = lines.join('\n').trim();
  try {
    const json = JSON.parse(text);
    if (json && typeof json.code !== 'undefined') return Number(json.code) === 200;
  } catch {
    // Not JSON — fall through to textual markers.
  }
  return !/未开通|未开启|NOT[_\s-]*(OPEN|BOUND|SET)|NEEDS?[_\s-]*SETUP|NO[_\s-]*WALLET/i.test(text);
}

/**
 * Pull the embedded resource JSON out of an alipay-bot 0.3.15 status report.
 *
 * The settled `402-query-payment-status` report (Shape C) embeds the re-fetched
 * resource after a `资源响应体：` label, e.g. `**资源响应体**：\n{ "success": true,
 * "result": { … } }`. We locate that label, brace-match the following JSON
 * object (string-aware, so braces inside values don't fool it), parse it and
 * surface `.result` (the seller's handler output). Returns `undefined` if no
 * embedded object is found, so the caller can fall back to the raw report.
 */
function extractResourceFromReport(report: string): string | undefined {
  const label = report.search(/资源响应体/);
  const start = report.indexOf('{', label === -1 ? 0 : label);
  if (start === -1) return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < report.length; i++) {
    const ch = report[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const slice = report.slice(start, i + 1);
      try {
        const obj = JSON.parse(slice);
        const r = obj?.resourceResponse ?? obj?.result ?? obj?.data ?? obj?.body ?? obj;
        return typeof r === 'string' ? r : JSON.stringify(r);
      } catch {
        return slice;
      }
    }
  }
  return undefined;
}

/**
 * Extract the resource body from the paid status-poll output.
 *
 * alipay-bot 0.3.15 (Shape C) wraps the settled report in `{body: "<markdown>"}`
 * with the resource embedded under a `资源响应体：` label — pull that out and
 * surface `.result`. Older/other shapes put the resource under data/result/body
 * at the top level. Falls back to a `BODY:` marker, then to the joined
 * non-marker lines. Verified live 2026-06-10 against a real completed trade.
 */
export function extractBody(lines: string[]): string {
  const text = lines.join('\n').trim();
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object') {
      // Preferred (alipay-bot ≥1.0.x): the settled result carries the delivered
      // resource in a structured `resourceResponse` field — the HTTP response
      // body from the bot's OWN authenticated x402 re-request (the bot holds the
      // Payment-Proof and re-requests `/execute` for us). Read that field
      // directly instead of scraping the human report. See docs/ALIPAY-RAIL.md
      // §9.3. `resourceResponse` may itself wrap the seller output under
      // `.result`/`.data`/`.body`, so surface that the same way the report path does.
      if (json.resourceResponse !== undefined && json.resourceResponse !== null) {
        const rr = json.resourceResponse;
        const r = (typeof rr === 'object')
          ? (rr.result ?? rr.data ?? rr.body ?? rr)
          : rr;
        return typeof r === 'string' ? r : JSON.stringify(r);
      }
      // Shape C: {body:"<markdown report>"} — dig out the embedded resource.
      if (typeof json.body === 'string') {
        const inner = extractResourceFromReport(json.body);
        return inner ?? json.body;
      }
      const body = json.data ?? json.result ?? json.body ?? json.resource;
      if (body !== undefined) return typeof body === 'string' ? body : JSON.stringify(body);
      return text;
    }
  } catch {
    // Not JSON — fall through.
  }
  const idx = lines.findIndex((l) => /^\s*BODY:/.test(l));
  if (idx !== -1) {
    const first = lines[idx].replace(/^\s*BODY:\s*/, '');
    return [first, ...lines.slice(idx + 1)].join('\n').trim();
  }
  return lines.filter((l) => !/^\s*(MEDIA|STATUS|INFO):/.test(l)).join('\n').trim();
}

/**
 * Default TTL (ms) for the positive check-wallet cache. The wallet
 * authorization is ACCOUNT-level and stable once opened, yet `pay402` re-runs
 * `check-wallet` on EVERY payment — measured ~22s each (the per-line timeline
 * shows a single silent ~22s gateway round-trip, then an instant `{code:200}`
 * dump). Overridable via `MOLTSPAY_ALIPAY_WALLET_TTL_MS`; set it to `0` to
 * disable the cache and always spawn `check-wallet`.
 */
const DEFAULT_WALLET_TTL_MS = 10 * 60 * 1000; // 10 min

function resolveWalletTtlMs(): number {
  const raw = process.env.MOLTSPAY_ALIPAY_WALLET_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WALLET_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WALLET_TTL_MS;
}

// Process-level positive cache, keyed by (configDir, framework) so distinct
// accounts never share state. We cache ONLY the "ready" verdict (a freshly
// bound wallet must be observed live, so NOT-ready is never cached) and ONLY
// for the DEFAULT runner — injected (test/DI) runners always spawn, exactly
// like the ensure-cli cache in ./install.ts.
const walletReadyUntil = new Map<string, number>();

/** Clear the check-wallet cache (tests, or after the user (un)binds a wallet). */
export function resetWalletCache(): void {
  walletReadyUntil.clear();
}

/**
 * Default TTL (ms) for the payment-intent handshake skip-cache. `payment-intent`
 * is a session handshake whose OUTPUT pay402 discards — it runs purely for its
 * CLI/server side-effect. The profiler showed each spawn costs ~5-9s, almost
 * all of it the alipay-bot per-process cold start (device-fingerprint + native
 * risk-control init), NOT gateway. Because `402-buyer-pay` is passed `-s/-i/-w`
 * and is "self-sufficient even if the cached intent didn't stick" (see step 4),
 * a handshake already done for this account need not be repeated per payment.
 * We therefore skip the spawn once one has succeeded within the TTL. The session
 * id is per-payment random, so — exactly like the wallet cache — we key by
 * (configDir, framework), the account-stable identity. Override via
 * `MOLTSPAY_ALIPAY_INTENT_TTL_MS`; set `0` to disable and always handshake.
 */
const DEFAULT_INTENT_TTL_MS = 10 * 60 * 1000; // 10 min

function resolveIntentTtlMs(): number {
  const raw = process.env.MOLTSPAY_ALIPAY_INTENT_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTENT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTENT_TTL_MS;
}

// Process-level "handshake done" cache, keyed (configDir, framework) like the
// wallet cache, and likewise only honored for the DEFAULT runner.
const intentDoneUntil = new Map<string, number>();

/** Clear the payment-intent skip-cache (tests, or after (un)bind / session reset). */
export function resetIntentCache(): void {
  intentDoneUntil.clear();
}

export class AlipayClient {
  private readonly sessionId: string;
  private readonly configDir: string;
  private readonly framework: string;
  private readonly runner: CliRunner;
  private readonly getVersion?: VersionGetter;
  private readonly now: () => number;
  /** Only the default runner may use the process-level wallet cache. */
  private readonly walletCacheable: boolean;
  /** Only the default runner may use the process-level payment-intent cache. */
  private readonly intentCacheable: boolean;

  constructor(opts: AlipayClientOptions = {}) {
    this.sessionId = resolveSessionId(opts.sessionId, process.env.AIPAY_SESSION_ID);
    this.configDir = opts.configDir ?? join(homedir(), '.moltspay');
    this.framework = opts.framework ?? process.env.AIPAY_FRAMEWORK ?? 'openclaw';
    this.runner = opts.runner ?? runCli;
    this.getVersion = opts.getVersion;
    this.now = opts.now ?? Date.now;
    this.walletCacheable = opts.cacheWallet ?? !opts.runner;
    this.intentCacheable = opts.cacheIntent ?? !opts.runner;
  }

  /**
   * Throws NeedsWalletSetupError unless alipay-bot reports an opened wallet.
   *
   * Skips the ~22s `check-wallet` spawn entirely when a prior call cached a
   * "ready" verdict within the TTL (see {@link DEFAULT_WALLET_TTL_MS}).
   */
  async checkWallet(signal?: AbortSignal, flow?: string): Promise<void> {
    const ttlMs = resolveWalletTtlMs();
    const cacheKey = `${this.configDir}::${this.framework}`;
    const useCache = this.walletCacheable && ttlMs > 0;

    if (useCache) {
      const until = walletReadyUntil.get(cacheKey);
      if (until !== undefined && this.now() < until) {
        alipayLog.info('wallet.cache', { flow, step: 'check-wallet', hit: true, ttlMsLeft: until - this.now() });
        return;
      }
    }

    const { lines } = await this.runner(['check-wallet'], { signal, step: 'check-wallet', flow });
    if (!isWalletReady(lines)) {
      // Defensive: drop any cache entry for this key. (We only reach here on a
      // cache MISS, so the entry is already absent or expired — but this keeps
      // the map from ever holding a key whose last observed verdict was NOT
      // ready. A fresh positive is recovered explicitly via resetWalletCache.)
      if (this.walletCacheable) walletReadyUntil.delete(cacheKey);
      throw new NeedsWalletSetupError(
        'Alipay wallet not opened. Run: moltspay alipay apply (then: moltspay alipay bind)',
      );
    }
    if (useCache) {
      walletReadyUntil.set(cacheKey, this.now() + ttlMs);
      alipayLog.info('wallet.cache', { flow, step: 'check-wallet', hit: false, cachedForMs: ttlMs });
    }
  }

  /** Run the full 8-step flow and resolve with the resource body. */
  async pay402(opts: AlipayPayOptions): Promise<AlipayPaymentResult> {
    const { resourceUrl, requirement, signal } = opts;
    const extra = (requirement.extra ?? {}) as Record<string, unknown>;
    const paymentNeededHeader = String(extra.payment_needed_header ?? '');
    if (!paymentNeededHeader) {
      throw new AlipayProtocolError('alipay requirement missing extra.payment_needed_header');
    }

    // Correlation id + clock for the per-flow timing breakdown (see ./log.ts).
    const flow = this.sessionId;
    const flowStart = this.now();
    alipayLog.info('flow.start', { flow, resource: resourceUrl });

    // MEDIA: lines are stripped from the verbatim stream and collected.
    const media: string[] = [];
    const onLine = (line: string) => {
      const m = extractMedia(line);
      if (m) media.push(m);
      else opts.onLine?.(line);
    };

    // intent-summary is REQUIRED by alipay-bot's payment-intent; derive a
    // minimal one from the requirement when the caller didn't supply it.
    const intentSummary =
      opts.intentSummary?.trim() ||
      `支付 ${requirement.amount ?? ''} ${requirement.asset ?? 'CNY'}`.trim();

    // Step 0: version gate.
    await timeStep('ensure-cli', flow, () => ensureCli(this.getVersion));

    // Step 1b: session handshake (--intent-summary is mandatory). Skipped when a
    // prior handshake for this (configDir, framework) is still within TTL — the
    // ~5-9s spawn is almost all CLI cold start, and 402-buyer-pay re-supplies
    // -s/-i/-w so it stands alone. See {@link DEFAULT_INTENT_TTL_MS}.
    const intentTtlMs = resolveIntentTtlMs();
    const intentKey = `${this.configDir}::${this.framework}`;
    const useIntentCache = this.intentCacheable && intentTtlMs > 0;
    const intentUntil = useIntentCache ? intentDoneUntil.get(intentKey) : undefined;
    if (intentUntil !== undefined && this.now() < intentUntil) {
      alipayLog.info('intent.cache', { flow, step: 'payment-intent', hit: true, ttlMsLeft: intentUntil - this.now() });
    } else {
      await this.runner(
        ['payment-intent', '--session-id', this.sessionId, '--intent-summary', intentSummary,
          '--framework', this.framework],
        { onLine, signal, step: 'payment-intent', flow },
      );
      if (useIntentCache) {
        intentDoneUntil.set(intentKey, this.now() + intentTtlMs);
        alipayLog.info('intent.cache', { flow, step: 'payment-intent', hit: false, cachedForMs: intentTtlMs });
      }
    }

    // Step 2: wallet must be opened.
    await this.checkWallet(signal, flow);

    // Step 3: dump Payment-Needed to a tmp file for 402-buyer-pay -f.
    const reqId = String(extra.out_trade_no ?? randomUUID());
    const dir = join(this.configDir, 'alipay');
    await mkdir(dir, { recursive: true });
    const challengeFile = join(dir, `402_${reqId}.txt`);
    await writeFile(challengeFile, paymentNeededHeader, 'utf-8');

    // Step 4: initiate the buyer payment → paymentUrl + tradeNo. Pass session +
    // intent + framework so buyer-pay is self-sufficient even if the cached
    // intent didn't stick.
    const payArgs = ['402-buyer-pay', '-f', challengeFile, '-r', resourceUrl,
      '-s', this.sessionId, '-i', intentSummary, '-w', this.framework];
    if (opts.method) payArgs.push('-m', opts.method);
    if (opts.data) payArgs.push('-d', opts.data);
    const payRun = await this.runner(payArgs, { onLine, signal, step: '402-buyer-pay', flow });

    const tradeNo = parseTradeNo(payRun.lines);
    if (!tradeNo) {
      throw new AlipayProtocolError('402-buyer-pay did not return a tradeNo');
    }
    assertTradeNo(tradeNo);

    const { paymentUrl, shortenUrl } = parsePaymentUrl(payRun.lines);
    if (paymentUrl) {
      // End of the user-visible "pre-QR" window: everything from flow.start to
      // here (402 → payment-intent → check-wallet → buyer-pay) ran before the
      // QR/link could be shown. This `ms` is the number to optimize.
      alipayLog.info('flow.pending', { flow, tradeNo, ms: this.now() - flowStart });
      opts.onPaymentPending?.({ paymentUrl, shortenUrl, tradeNo });
    }

    // Step 5: poll until terminal. Deadline = explicit timeout or pay_before window.
    const pendingAt = this.now();
    const windowMs = (requirement.maxTimeoutSeconds ?? 30 * 60) * 1000;
    const deadline = this.now() + (opts.timeoutMs ?? windowMs);
    const poll = await pollUntil(tradeNo, resourceUrl, {
      // No onLine: the status-poll output embeds the resource and must not reach
      // the log stream — the body is surfaced via the return value below (§9.3).
      deadline,
      signal,
      runner: this.runner,
      now: this.now,
      // Re-fetch the resource the same way it was paid (POST + body), else the
      // status poll defaults to GET and 404s on a POST-only `/execute`.
      method: opts.method,
      data: opts.data,
    });

    // Settlement reached: time spent waiting for the buyer to scan + pay + the
    // facilitator to confirm (distinct from the pre-QR window above).
    alipayLog.info('flow.settled', { flow, tradeNo, ms: this.now() - pendingAt });

    // Step 7: surface the resource body.
    const body = extractBody(poll.lines);

    // Step 8: fire-and-forget fulfillment ack (best-effort; never blocks the result).
    void this.runner(['402-buyer-fulfillment-ack', '-t', tradeNo], {
      onLine, signal, step: '402-buyer-fulfillment-ack', flow,
    }).catch(() => undefined);

    return { body, payment: { tradeNo, outTradeNo: reqId }, media };
  }
}
