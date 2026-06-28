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

export interface WechatPaymentResult {
  /** Raw resource body returned by the server on success (HTTP 200). */
  body: string;
  status: number;
}

export class WechatClient {
  async pay402(opts: WechatPayOptions): Promise<WechatPaymentResult> {
    const extra = (opts.requirement.extra ?? {}) as Record<string, unknown>;
    const codeUrl = typeof extra.code_url === 'string' ? extra.code_url : '';
    const outTradeNo = typeof extra.out_trade_no === 'string' ? extra.out_trade_no : '';
    if (!codeUrl || !outTradeNo) {
      throw new Error(
        'WechatClient.pay402: wechatpay-native requirement is missing extra.code_url / extra.out_trade_no',
      );
    }

    // Step 1: hand the code_url to the caller (CLI/bot renders it as a QR).
    opts.onPaymentPending?.({ codeUrl, outTradeNo });

    // The x402 proof: the server reads payment.accepted.extra.out_trade_no and
    // verifies the order via the WeChat gateway (it holds the merchant creds).
    const proof = {
      x402Version: 2,
      scheme: WECHAT_SCHEME,
      network: WECHAT_NETWORK,
      accepted: {
        scheme: WECHAT_SCHEME,
        network: WECHAT_NETWORK,
        extra: { out_trade_no: outTradeNo },
      },
      payload: { out_trade_no: outTradeNo },
    };
    const xPayment = Buffer.from(JSON.stringify(proof)).toString('base64');

    const method = opts.method ?? 'POST';
    const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    const budget = opts.timeoutMs ?? TIMEOUT_MS;
    const deadline = Date.now() + budget;

    // Step 2: poll until paid.
    let lastStatus = 0;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('WeChat payment aborted');

      const res = await fetch(opts.resourceUrl, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Payment': xPayment },
        body: method === 'POST' ? opts.data : undefined,
      });
      lastStatus = res.status;

      if (res.status === 200) {
        return { body: await res.text(), status: 200 };
      }
      // 402 == not yet paid (NOTPAY); anything else is terminal.
      const text = await res.text().catch(() => '');
      if (res.status !== 402) {
        throw new Error(
          `WeChat /execute returned HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(
      `WeChat payment timed out after ${Math.round(budget / 1000)}s ` +
        `(out_trade_no=${outTradeNo}, last status ${lastStatus})`,
    );
  }
}
