/**
 * Custodial balance rail HTTP management endpoints (`/balance/*`), extracted
 * from index.ts to keep the server class focused. A thin collaborator injected
 * with the pieces it needs (facilitators, manifest, sendJson, and the WeChat
 * pending-order helpers) so it can be unit-driven and keeps index.ts small.
 *
 * Behavior is unchanged from the in-class handlers; see
 * WECHAT-BALANCE-PASSWORDLESS-DESIGN.md and BALANCE-RAIL-DESIGN.md.
 */
import { ServerResponse } from 'http';
import crypto from 'node:crypto';
import {
  WechatFacilitator,
  BalanceFacilitator,
  WECHAT_NETWORK,
  WECHAT_SCHEME,
  parseWechatAttach,
  toSat,
  fromSat,
} from '../facilitators/index.js';
import { X402PaymentPayload, X402PaymentRequirements } from '../facilitators/interface.js';
import { verifyPayment as verifyOnChainPayment } from '../verify/index.js';
import { ServicesManifest } from './types.js';
import { X402_VERSION } from './internal.js';

/** A pending WeChat order as returned by the shared get-or-create helper. */
type PendingWechatOrder = {
  accepts: X402PaymentRequirements;
  codeUrl: string;
  outTradeNo: string;
};

/** Dependencies injected from MoltsPayServer. */
export interface BalanceEndpointsDeps {
  manifest: ServicesManifest;
  balance: BalanceFacilitator;
  wechat: WechatFacilitator | null;
  sendJson: (res: ServerResponse, status: number, data: any) => void;
  getOrCreatePendingWechatOrder: (
    cacheKey: string,
    logLabel: string,
    create: () => Promise<{ x402Accepts: X402PaymentRequirements; codeUrl: string; outTradeNo: string }>,
  ) => Promise<PendingWechatOrder | null>;
  invalidateWechatChallenge: (outTradeNo: string) => void;
}

export class BalanceEndpoints {
  constructor(private readonly deps: BalanceEndpointsDeps) {}

  /** GET /balance?buyer_id= -- balance, limits, and today's spend. */
  handleQuery(url: URL, res: ServerResponse): void {
    const { balance, sendJson } = this.deps;
    const buyerId = url.searchParams.get('buyer_id');
    if (!buyerId) {
      return sendJson(res, 400, { error: 'buyer_id query parameter is required' });
    }
    const ledger = balance.getLedger();
    const buyer = ledger.getBuyer(buyerId);
    if (!buyer) {
      // A never-seen buyer is a valid empty account, not an error.
      return sendJson(res, 200, {
        buyer_id: buyerId,
        balance: '0.00',
        currency: balance.currency,
        exists: false,
      });
    }
    sendJson(res, 200, {
      buyer_id: buyerId,
      balance: fromSat(buyer.balance_sat),
      currency: balance.currency,
      single_limit: fromSat(buyer.single_limit_sat),
      daily_limit: fromSat(buyer.daily_limit_sat),
      today_spent: fromSat(ledger.spentTodaySat(buyerId)),
      status: buyer.status,
      wechat_openid: buyer.wechat_openid ?? null,
      exists: true,
    });
  }

  /**
   * Extract the gateway-confirmed paid amount (fen) from a WeChat verify
   * result. `payer_total` is what the buyer actually paid; falls back to
   * `total`. Returns null if no usable positive integer is present, so the
   * client-declared amount can never be trusted for crediting.
   */
  private wechatPaidFen(check: { details?: { amount?: unknown } }): number | null {
    const amount = check.details?.amount as { payer_total?: unknown; total?: unknown } | undefined;
    const paid = amount?.payer_total ?? amount?.total;
    return typeof paid === 'number' && Number.isFinite(paid) && paid > 0 ? paid : null;
  }

  /**
   * POST /balance/topup/order -- mint a buyer-bound WeChat Native order for a
   * configured top-up pack. The buyer_id rides in the WeChat `attach` so the
   * later confirm/callback credits the correct balance. Reuses the pending
   * order cache (keyed by buyer_id + pack) so concurrent requests share one
   * order. Body: `{ buyer_id, pack? }`. Returns `{ code_url, out_trade_no,
   * pack, max_timeout_seconds }`.
   */
  async handleTopupOrder(body: any, res: ServerResponse): Promise<void> {
    const { manifest, wechat, sendJson, getOrCreatePendingWechatOrder } = this.deps;
    const { buyer_id, pack } = body || {};
    if (typeof buyer_id !== 'string' || !buyer_id) {
      return sendJson(res, 400, { error: 'buyer_id is required' });
    }
    if (!wechat) {
      return sendJson(res, 400, { error: 'WeChat rail not configured on this server' });
    }
    const balCfg = manifest.provider.balance;
    const packs = balCfg?.topup_packs ?? [];
    const chosen: string | undefined =
      typeof pack === 'string' && pack ? pack : balCfg?.default_pack;
    if (!chosen) {
      return sendJson(res, 400, { error: 'no pack specified and no default_pack configured' });
    }
    // Accept a pack that is either offered or within the auto-topup ceiling.
    let chosenSat: number;
    try {
      chosenSat = toSat(chosen);
      if (chosenSat <= 0) throw new Error('pack must be positive');
    } catch (err: any) {
      return sendJson(res, 400, { error: `Invalid pack: ${err.message}` });
    }
    const withinMax = balCfg?.auto_topup_max ? chosenSat <= toSat(balCfg.auto_topup_max) : false;
    if (!packs.includes(chosen) && !withinMax) {
      return sendJson(res, 400, {
        error: `pack "${chosen}" is not an offered top-up pack and exceeds auto_topup_max`,
      });
    }

    const nonce = crypto.randomBytes(8).toString('hex');
    const cacheKey = crypto
      .createHash('sha256')
      .update(`topup|${buyer_id}|${chosen}`)
      .digest('hex');
    const result = await getOrCreatePendingWechatOrder(cacheKey, `topup:${buyer_id}`, () =>
      wechat.createPaymentRequirements({
        priceCny: chosen,
        description: `Balance top-up ${chosen}`,
        attach: { buyer_id, nonce },
      }),
    );
    if (!result) {
      return sendJson(res, 502, { error: 'failed to create WeChat top-up order' });
    }
    return sendJson(res, 200, {
      code_url: result.codeUrl,
      out_trade_no: result.outTradeNo,
      pack: chosen,
      max_timeout_seconds: result.accepts.maxTimeoutSeconds,
    });
  }

  /**
   * POST /balance/topup/confirm -- the polling-fallback credit path. The client
   * polls this after a scan; the server verifies the order with the WeChat
   * gateway and, on SUCCESS, credits the buyer bound in `attach` with the
   * gateway-confirmed `payer_total` (never a client-declared amount).
   * Idempotent on `wechat:<out_trade_no>`. Body: `{ out_trade_no }`.
   */
  async handleTopupConfirm(body: any, res: ServerResponse): Promise<void> {
    const { manifest, balance, wechat, sendJson, invalidateWechatChallenge } = this.deps;
    const outTradeNo = body?.out_trade_no;
    if (typeof outTradeNo !== 'string' || !outTradeNo) {
      return sendJson(res, 400, { error: 'out_trade_no is required' });
    }
    if (!wechat) {
      return sendJson(res, 400, { error: 'WeChat rail not configured on this server' });
    }
    const wxPayload: X402PaymentPayload = {
      x402Version: X402_VERSION,
      scheme: WECHAT_SCHEME,
      network: WECHAT_NETWORK,
      payload: { out_trade_no: outTradeNo },
    };
    const wxReqs: X402PaymentRequirements = {
      scheme: WECHAT_SCHEME, network: WECHAT_NETWORK, asset: 'CNY', amount: '0',
      payTo: manifest.provider.wechat?.mchid || '', maxTimeoutSeconds: 30,
      extra: { out_trade_no: outTradeNo },
    };
    const check = await wechat.verify(wxPayload, wxReqs);
    if (!check.valid) {
      // Not yet paid (or a transient gateway error): tell the client to keep
      // polling rather than surfacing an error.
      return sendJson(res, 200, { credited: false, pending: true, reason: check.error });
    }
    const paidFen = this.wechatPaidFen(check);
    if (paidFen === null) {
      return sendJson(res, 502, { error: 'WeChat order verification did not return a usable paid amount' });
    }
    const attach = parseWechatAttach((check.details as { attach?: unknown } | undefined)?.attach);
    const buyerId = attach?.buyer_id;
    if (!buyerId) {
      return sendJson(res, 422, {
        error: 'top-up order has no buyer binding (attach.buyer_id missing)',
      });
    }
    const credited = balance.credit({
      buyerId,
      amountSat: paidFen,
      externalRef: `wechat:${outTradeNo}`,
      description: `wechat topup out_trade_no=${outTradeNo} fiat=${JSON.stringify(check.details?.amount ?? null)}`,
    });
    // Paid orders can leave the pending cache immediately (one code, one payment).
    invalidateWechatChallenge(outTradeNo);
    // Stage 1a: record the gateway-attested payer openid that funded this
    // account (observational — anchors the balance to a real WeChat user).
    const openid = (check.details as { openid?: unknown } | undefined)?.openid;
    let openidBinding: { bound: boolean; conflict: boolean; existing: string | null } | undefined;
    if (typeof openid === 'string' && openid) {
      openidBinding = balance.getLedger().bindOpenid(buyerId, openid);
      if (openidBinding.conflict) {
        console.warn(
          `[MoltsPay] Balance top-up openid conflict for buyer=${buyerId}: ` +
            `already bound to ${openidBinding.existing}, this payment from ${openid} — recorded, not enforced`,
        );
      }
    }
    console.log(
      `[MoltsPay] Balance top-up credited buyer=${buyerId} +${fromSat(paidFen)} ` +
        `(${outTradeNo})${credited.replayed ? ' [replayed]' : ''}` +
        `${typeof openid === 'string' && openid ? ` openid=${openid}${openidBinding?.conflict ? ' [CONFLICT]' : ''}` : ''}`,
    );
    return sendJson(res, 200, {
      credited: true,
      buyer_id: buyerId,
      tx_id: credited.txId,
      balance: credited.balance,
      replayed: credited.replayed,
      openid_bound: openidBinding?.bound ?? false,
      openid_conflict: openidBinding?.conflict ?? false,
    });
  }

  /**
   * POST /balance/topup -- verify an externally settled payment and credit the
   * buyer's ledger balance (operator/recovery path). Per rail: `crypto`
   * verifies the tx on-chain; `wechat` queries the order and credits the
   * gateway-confirmed payer_total (never the client-declared amount);
   * `alipay` is operator-trusted in this MVP. Idempotent on the external ref.
   */
  async handleTopup(body: any, res: ServerResponse): Promise<void> {
    const { manifest, balance, wechat, sendJson } = this.deps;
    const { buyer_id, rail, amount } = body || {};
    if (typeof buyer_id !== 'string' || !buyer_id) {
      return sendJson(res, 400, { error: 'buyer_id is required' });
    }
    let amountSat: number;
    try {
      amountSat = toSat(String(amount));
      if (amountSat <= 0) throw new Error('amount must be positive');
    } catch (err: any) {
      return sendJson(res, 400, { error: `Invalid amount: ${err.message}` });
    }

    let externalRef: string;
    let description: string;
    if (rail === 'crypto') {
      const txHash = body.tx_hash;
      if (typeof txHash !== 'string' || !txHash) {
        return sendJson(res, 400, { error: 'tx_hash is required for rail "crypto"' });
      }
      const check = await verifyOnChainPayment({
        txHash,
        expectedAmount: amountSat / 100,
        expectedTo: manifest.provider.wallet,
        chain: body.chain || 'base',
      });
      if (!check.verified) {
        return sendJson(res, 402, { error: `On-chain verification failed: ${check.error}` });
      }
      externalRef = txHash.toLowerCase();
      description = `crypto topup ${check.amount} ${check.token} on ${body.chain || 'base'}`;
    } else if (rail === 'wechat') {
      const outTradeNo = body.out_trade_no;
      if (typeof outTradeNo !== 'string' || !outTradeNo) {
        return sendJson(res, 400, { error: 'out_trade_no is required for rail "wechat"' });
      }
      if (!wechat) {
        return sendJson(res, 400, { error: 'WeChat rail not configured on this server' });
      }
      const wxPayload: X402PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: WECHAT_SCHEME,
        network: WECHAT_NETWORK,
        payload: { out_trade_no: outTradeNo },
      };
      const wxReqs: X402PaymentRequirements = {
        scheme: WECHAT_SCHEME, network: WECHAT_NETWORK, asset: 'CNY', amount: '0',
        payTo: manifest.provider.wechat?.mchid || '', maxTimeoutSeconds: 30,
        extra: { out_trade_no: outTradeNo },
      };
      const check = await wechat.verify(wxPayload, wxReqs);
      if (!check.valid) {
        return sendJson(res, 402, { error: `WeChat order verification failed: ${check.error}` });
      }
      // Credit what WeChat actually confirms was paid on this order, not the
      // client-declared `amount` -- otherwise a buyer can pay 0.01 CNY and claim
      // any amount. `payer_total` is fen, which is 1:1 with ledger cents.
      const paidFen = this.wechatPaidFen(check);
      if (paidFen === null) {
        return sendJson(res, 502, { error: 'WeChat order verification did not return a usable paid amount' });
      }
      if (paidFen !== amountSat) {
        console.warn(
          `[MoltsPay] WeChat topup amount mismatch for ${outTradeNo}: client declared ${fromSat(amountSat)}, ` +
            `gateway confirms ${fromSat(paidFen)} paid -- crediting the verified amount`
        );
      }
      amountSat = paidFen;
      externalRef = `wechat:${outTradeNo}`;
      description = `wechat topup out_trade_no=${outTradeNo} fiat=${JSON.stringify(check.details?.amount ?? null)}`;
      console.log(`[MoltsPay] WeChat topup verified: ${description}`);
    } else if (rail === 'alipay') {
      const tradeNo = body.trade_no;
      if (typeof tradeNo !== 'string' || !tradeNo) {
        return sendJson(res, 400, { error: 'trade_no is required for rail "alipay"' });
      }
      // MVP: no gateway verification possible without the buyer's
      // payment_proof -- operator-trusted credit, idempotent on trade_no.
      externalRef = `alipay:${tradeNo}`;
      description = `alipay topup trade_no=${tradeNo} (operator-confirmed, unverified)`;
      console.warn(`[MoltsPay] Alipay topup credited without gateway verification: ${tradeNo}`);
    } else {
      return sendJson(res, 400, { error: 'rail must be one of "crypto" | "alipay" | "wechat"' });
    }

    const result = balance.getLedger().topup({ buyerId: buyer_id, amountSat, externalRef, description });
    sendJson(res, 200, {
      success: true,
      tx_id: result.txId,
      balance: fromSat(result.balanceSat),
      replayed: result.replayed ?? false,
    });
  }

  /** POST /balance/refund -- reverse a deduct (operator/agent use). */
  handleRefund(body: any, res: ServerResponse): void {
    const { balance, sendJson } = this.deps;
    const { tx_id, reason } = body || {};
    if (typeof tx_id !== 'string' || !tx_id) {
      return sendJson(res, 400, { error: 'tx_id is required' });
    }
    const result = balance.refund(tx_id, typeof reason === 'string' ? reason : undefined);
    if (!result.success) {
      return sendJson(res, result.error === 'tx_not_found' ? 404 : 400, { error: result.error });
    }
    sendJson(res, 200, {
      success: true,
      tx_id: result.txId,
      balance: fromSat(result.balanceSat!),
      replayed: result.replayed ?? false,
    });
  }

  /** GET /balance/transactions?buyer_id=&limit=&offset= -- history, newest first. */
  handleTransactions(url: URL, res: ServerResponse): void {
    const { balance, sendJson } = this.deps;
    const buyerId = url.searchParams.get('buyer_id');
    if (!buyerId) {
      return sendJson(res, 400, { error: 'buyer_id query parameter is required' });
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
    const rows = balance.getLedger().listTransactions(buyerId, limit, offset);
    sendJson(res, 200, {
      buyer_id: buyerId,
      transactions: rows.map(r => ({
        tx_id: r.id,
        type: r.type,
        amount: fromSat(r.amount_sat),
        service: r.service,
        description: r.description,
        external_ref: r.external_ref,
        status: r.status,
        created_at: r.created_at,
      })),
    });
  }
}
