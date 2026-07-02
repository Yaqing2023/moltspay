/**
 * WechatClient — buyer-side completion for the WeChat Pay Native rail (2.1.0).
 *
 * Mirrors {@link AlipayClient} so paying via WeChat looks the same as awaiting
 * an EVM settle. The flow is simpler than Alipay's: the SERVER already placed
 * the Native order when it built the 402, so its `wechatpay-native` accepts[]
 * entry carries `extra.code_url` + `extra.out_trade_no`. There is no buyer-side
 * CLI/wallet and no order creation here — a human scans the code_url with the
 * WeChat app, and the client polls the resource endpoint, re-submitting the
 * `out_trade_no` as the x402 payment proof until the server verifies the order
 * as paid (`trade_state === SUCCESS`) and delivers the resource.
 *
 *   1. surface code_url + out_trade_no to the caller (onPaymentPending → QR)
 *   2. poll POST <resource> with X-Payment{out_trade_no} every pollIntervalMs
 *      - 200            → paid, return the resource body
 *      - 402            → not yet paid, keep polling
 *      - other          → terminal error
 *   3. give up after timeoutMs
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { X402PaymentRequirements } from '../core/types.js';

/** x402 scheme/network identifiers for the WeChat Native rail. */
export const WECHAT_SCHEME = 'wechatpay-native';
export const WECHAT_NETWORK = 'wechat';

/** Default 3s poll cadence — matches the Alipay rail. */
const POLL_INTERVAL_MS = 3000;
/** Default 5min budget — a Native code expires well after this. */
const TIMEOUT_MS = 5 * 60 * 1000;

export interface WechatPendingInfo {
  /** `weixin://wxpay/bizpayurl?pr=...` — render as a QR for the payer to scan. */
  codeUrl: string;
  /** Merchant order id; the proof echoed back to the server on each poll. */
  outTradeNo: string;
}

export type WechatSessionStatus = 'pending' | 'paid' | 'completed' | 'expired' | 'cancelled' | 'failed';

export interface WechatPaymentSession {
  paymentSessionId: string;
  status: WechatSessionStatus;
  resourceUrl: string;
  method: 'GET' | 'POST';
  data?: string;
  requirement: X402PaymentRequirements;
  codeUrl: string;
  outTradeNo: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  context?: Record<string, unknown>;
  lastHttpStatus?: number;
  lastError?: string;
  resultBody?: string;
}

export interface WechatPayOptions {
  /** Resource/execute URL to re-POST the proof to (same one that issued the 402). */
  resourceUrl: string;
  /** The server's `wechatpay-native` accepts[] entry (carries extra.code_url/out_trade_no). */
  requirement: X402PaymentRequirements;
  /** HTTP method of the original resource request (default POST). */
  method?: 'GET' | 'POST';
  /** Raw JSON body to replay on each poll (the `{ service, params }` payload). */
  data?: string;
  /** Surface the QR code_url + out_trade_no to the UI/caller (called once). */
  onPaymentPending?: (info: WechatPendingInfo) => void;
  /** Poll cadence in ms (default 3000). */
  pollIntervalMs?: number;
  /** Overall budget in ms (default 300000). */
  timeoutMs?: number;
  /** Cancellation. */
  signal?: AbortSignal;
}

export interface WechatStartOptions extends WechatPayOptions {
  /** Optional channel/service metadata persisted with the session for recovery. */
  context?: Record<string, unknown>;
  /** Stable session id, mostly for tests/integration. Defaults to `mpay_sess_${uuid}`. */
  paymentSessionId?: string;
}

export interface WechatPaymentResult {
  /** Raw resource body returned by the server on success (HTTP 200). */
  body: string;
  status: number;
}

export interface WechatClientOptions {
  /** Config directory; sessions are stored under `<configDir>/wechat-sessions`. */
  configDir?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class WechatClient {
  private readonly configDir: string;
  private readonly sessionDir: string;
  private readonly now: () => number;

  constructor(options: WechatClientOptions = {}) {
    this.configDir = options.configDir || join(homedir(), '.moltspay');
    this.sessionDir = join(this.configDir, 'wechat-sessions');
    this.now = options.now ?? Date.now;
  }

  async pay402(opts: WechatPayOptions): Promise<WechatPaymentResult> {
    const session = this.start402({ ...opts });
    const result = await this.pollSession(session.paymentSessionId, {
      pollIntervalMs: opts.pollIntervalMs,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    if (result.status === 'paid' || result.status === 'completed') {
      return {
        body: result.resultBody ?? '',
        status: result.lastHttpStatus ?? 200,
      };
    }
    throw new Error(result.lastError || `WeChat payment ended with status ${result.status}`);
  }

  /**
   * Start a recoverable WeChat payment session. This returns immediately after
   * persisting `out_trade_no`, QR payload, original request body, and context.
   */
  start402(opts: WechatStartOptions): WechatPaymentSession {
    const extra = (opts.requirement.extra ?? {}) as Record<string, unknown>;
    const codeUrl = typeof extra.code_url === 'string' ? extra.code_url : '';
    const outTradeNo = typeof extra.out_trade_no === 'string' ? extra.out_trade_no : '';
    if (!codeUrl || !outTradeNo) {
      throw new Error(
        'WechatClient.pay402: wechatpay-native requirement is missing extra.code_url / extra.out_trade_no',
      );
    }

    const now = new Date(this.now());
    const timeoutMs = opts.timeoutMs ?? (opts.requirement.maxTimeoutSeconds ?? TIMEOUT_MS / 1000) * 1000;
    const session: WechatPaymentSession = {
      paymentSessionId: opts.paymentSessionId ?? `mpay_sess_${randomUUID()}`,
      status: 'pending',
      resourceUrl: opts.resourceUrl,
      method: opts.method ?? 'POST',
      data: opts.data,
      requirement: opts.requirement,
      codeUrl,
      outTradeNo,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(this.now() + timeoutMs).toISOString(),
      context: opts.context,
    };
    this.saveSession(session);

    // Hand the code_url to the caller (CLI/bot renders it as a QR).
    opts.onPaymentPending?.({ codeUrl, outTradeNo });
    return session;
  }

  /**
   * Query a persisted session once by replaying the original request with the
   * stored `out_trade_no` proof. 200 means paid + fulfilled; 402 means pending.
   */
  async status(identifier: string): Promise<WechatPaymentSession> {
    const session = this.loadSession(identifier);
    if (session.status === 'cancelled' || session.status === 'completed') return session;
    if (this.now() >= new Date(session.expiresAt).getTime()) {
      return this.updateSession(session, {
        status: 'expired',
        lastError: `WeChat payment expired at ${session.expiresAt}`,
      });
    }

    const xPayment = this.buildPaymentHeader(session);
    const res = await fetch(session.resourceUrl, {
      method: session.method,
      headers: { 'Content-Type': 'application/json', 'X-Payment': xPayment },
      body: session.method === 'POST' ? session.data : undefined,
    });
    const text = await res.text().catch(() => '');

    if (res.status === 200) {
      return this.updateSession(session, {
        status: 'completed',
        lastHttpStatus: res.status,
        lastError: undefined,
        resultBody: text,
      });
    }

    if (res.status === 402) {
      return this.updateSession(session, {
        status: 'pending',
        lastHttpStatus: res.status,
        lastError: text.slice(0, 500) || 'wechat payment pending',
      });
    }

    return this.updateSession(session, {
      status: 'failed',
      lastHttpStatus: res.status,
      lastError: `WeChat /execute returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    });
  }

  /** Poll a session until it completes, expires, fails, or is aborted. */
  async pollSession(
    identifier: string,
    opts: Pick<WechatPayOptions, 'pollIntervalMs' | 'timeoutMs' | 'signal'> = {},
  ): Promise<WechatPaymentSession> {
    const first = this.loadSession(identifier);
    const deadline = Math.min(
      new Date(first.expiresAt).getTime(),
      this.now() + (opts.timeoutMs ?? TIMEOUT_MS),
    );
    const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    let session = first;

    while (this.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('WeChat payment aborted');
      session = await this.status(session.paymentSessionId);
      if (session.status !== 'pending') return session;
      await new Promise((r) => setTimeout(r, interval));
    }

    return this.updateSession(session, {
      status: 'expired',
      lastError:
        `WeChat payment timed out after ${Math.round((opts.timeoutMs ?? TIMEOUT_MS) / 1000)}s ` +
        `(out_trade_no=${session.outTradeNo}, last status ${session.lastHttpStatus ?? 0})`,
    });
  }

  /** `fulfill` is an idempotent status check: paid sessions return stored body. */
  async fulfill(identifier: string): Promise<WechatPaymentSession> {
    const session = this.loadSession(identifier);
    if (session.status === 'completed') return session;
    return this.status(identifier);
  }

  /** Mark a local session cancelled. Closing the merchant order is server-side. */
  cancel(identifier: string): WechatPaymentSession {
    const session = this.loadSession(identifier);
    return this.updateSession(session, {
      status: 'cancelled',
      lastError: 'cancelled locally',
    });
  }

  listSessions(): WechatPaymentSession[] {
    this.ensureSessionDir();
    return readdirSync(this.sessionDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(this.sessionDir, name), 'utf-8')) as WechatPaymentSession)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private buildPaymentHeader(session: WechatPaymentSession): string {
    // The x402 proof: the server reads accepted.extra.out_trade_no and verifies
    // the order via the WeChat gateway (it holds the merchant creds).
    const proof = {
      x402Version: 2,
      scheme: WECHAT_SCHEME,
      network: WECHAT_NETWORK,
      accepted: {
        scheme: WECHAT_SCHEME,
        network: WECHAT_NETWORK,
        extra: { out_trade_no: session.outTradeNo },
      },
      payload: { out_trade_no: session.outTradeNo },
    };
    return Buffer.from(JSON.stringify(proof)).toString('base64');
  }

  private loadSession(identifier: string): WechatPaymentSession {
    this.ensureSessionDir();
    const direct = join(this.sessionDir, `${identifier}.json`);
    try {
      return JSON.parse(readFileSync(direct, 'utf-8')) as WechatPaymentSession;
    } catch {
      const byTradeNo = this.listSessions().find((s) => s.outTradeNo === identifier);
      if (byTradeNo) return byTradeNo;
      throw new Error(`WeChat payment session not found: ${identifier}`);
    }
  }

  private saveSession(session: WechatPaymentSession): void {
    this.ensureSessionDir();
    writeFileSync(
      join(this.sessionDir, `${session.paymentSessionId}.json`),
      JSON.stringify(session, null, 2),
    );
  }

  private updateSession(
    session: WechatPaymentSession,
    updates: Partial<WechatPaymentSession>,
  ): WechatPaymentSession {
    const next = {
      ...session,
      ...updates,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.saveSession(next);
    return next;
  }

  private ensureSessionDir(): void {
    mkdirSync(this.sessionDir, { recursive: true });
  }
}
