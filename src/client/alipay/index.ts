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
  /** DI seams for tests. */
  runner?: CliRunner;
  getVersion?: VersionGetter;
  now?: () => number;
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
    const url = m[1];
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
 * Extract the resource body from the paid status-poll output. Prefers an
 * explicit `BODY:` marker; otherwise returns the joined non-marker lines.
 */
export function extractBody(lines: string[]): string {
  const idx = lines.findIndex((l) => /^\s*BODY:/.test(l));
  if (idx !== -1) {
    const first = lines[idx].replace(/^\s*BODY:\s*/, '');
    return [first, ...lines.slice(idx + 1)].join('\n').trim();
  }
  return lines.filter((l) => !/^\s*(MEDIA|STATUS|INFO):/.test(l)).join('\n').trim();
}

export class AlipayClient {
  private readonly sessionId: string;
  private readonly configDir: string;
  private readonly runner: CliRunner;
  private readonly getVersion?: VersionGetter;
  private readonly now: () => number;

  constructor(opts: AlipayClientOptions = {}) {
    this.sessionId = resolveSessionId(opts.sessionId, process.env.AIPAY_SESSION_ID);
    this.configDir = opts.configDir ?? join(homedir(), '.moltspay');
    this.runner = opts.runner ?? runCli;
    this.getVersion = opts.getVersion;
    this.now = opts.now ?? Date.now;
  }

  /** Throws NeedsWalletSetupError unless alipay-bot reports an opened wallet. */
  async checkWallet(signal?: AbortSignal): Promise<void> {
    const { exitCode, lines } = await this.runner(['check-wallet'], { signal });
    const text = lines.join('\n').toUpperCase();
    const notReady = exitCode !== 0 || /NOT[_\s-]*(OPEN|BOUND|SET)|NEEDS?[_\s-]*SETUP|NO[_\s-]*WALLET/.test(text);
    if (notReady) {
      throw new NeedsWalletSetupError(
        'Alipay wallet not opened. Run: moltspay alipay apply (then: moltspay alipay bind)',
      );
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

    // MEDIA: lines are stripped from the verbatim stream and collected.
    const media: string[] = [];
    const onLine = (line: string) => {
      const m = extractMedia(line);
      if (m) media.push(m);
      else opts.onLine?.(line);
    };

    // Step 0: version gate.
    await ensureCli(this.getVersion);

    // Step 1b: session handshake.
    await this.runner(
      ['payment-intent', '--session-id', this.sessionId, '--framework', 'moltspay'],
      { onLine, signal },
    );

    // Step 2: wallet must be opened.
    await this.checkWallet(signal);

    // Step 3: dump Payment-Needed to a tmp file for 402-buyer-pay -f.
    const reqId = String(extra.out_trade_no ?? randomUUID());
    const dir = join(this.configDir, 'alipay');
    await mkdir(dir, { recursive: true });
    const challengeFile = join(dir, `402_${reqId}.txt`);
    await writeFile(challengeFile, paymentNeededHeader, 'utf-8');

    // Step 4: initiate the buyer payment → paymentUrl + tradeNo.
    const payArgs = ['402-buyer-pay', '-f', challengeFile, '-r', resourceUrl];
    if (opts.method) payArgs.push('-m', opts.method);
    if (opts.data) payArgs.push('-d', opts.data);
    const payRun = await this.runner(payArgs, { onLine, signal });

    const tradeNo = parseTradeNo(payRun.lines);
    if (!tradeNo) {
      throw new AlipayProtocolError('402-buyer-pay did not return a tradeNo');
    }
    assertTradeNo(tradeNo);

    const { paymentUrl, shortenUrl } = parsePaymentUrl(payRun.lines);
    if (paymentUrl) {
      opts.onPaymentPending?.({ paymentUrl, shortenUrl, tradeNo });
    }

    // Step 5: poll until terminal. Deadline = explicit timeout or pay_before window.
    const windowMs = (requirement.maxTimeoutSeconds ?? 30 * 60) * 1000;
    const deadline = this.now() + (opts.timeoutMs ?? windowMs);
    const poll = await pollUntil(tradeNo, resourceUrl, {
      deadline,
      signal,
      onLine,
      runner: this.runner,
      now: this.now,
    });

    // Step 7: surface the resource body.
    const body = extractBody(poll.lines);

    // Step 8: fire-and-forget fulfillment ack (best-effort; never blocks the result).
    void this.runner(['402-buyer-fulfillment-ack', '-t', tradeNo], { onLine, signal }).catch(
      () => undefined,
    );

    return { body, payment: { tradeNo, outTradeNo: reqId }, media };
  }
}
