/**
 * WeChat Pay v3 JSON API caller.
 *
 * Wraps the REST/JSON gateway (`https://api.mch.weixin.qq.com`). Handles:
 * - SHA256-RSA request signing + the `Authorization` header (see ./sign.ts)
 * - JSON body / response marshalling
 * - optional response signature verification against the WeChat platform
 *   public key (enabled when `platform_public_key_pem` is configured)
 * - uniform error surfacing: non-2xx throws a {@link WechatApiError} carrying
 *   the gateway `code`/`message`
 *
 * Unlike Alipay's form-urlencoded gateway, v3 is plain REST: the method +
 * path + body are signed, and the business payload IS the HTTP body (no
 * `biz_content` wrapper).
 *
 * @see https://pay.weixin.qq.com/docs/merchant/development/interface-rules/
 */

import {
  wechatV3Sign,
  buildAuthorizationToken,
  wechatV3VerifyResponse,
  generateNonce,
} from './sign.js';

/** Default production base URL for the v3 REST gateway. */
export const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';

/**
 * Credentials + endpoint for a single v3 call. Sourced from
 * `provider.wechat` in `moltspay.services.json` (PEMs resolved by the server).
 */
export interface WechatV3Config {
  /** Merchant id (mchid). */
  mchid: string;
  /** Merchant API certificate serial number. */
  serial_no: string;
  /** Merchant RSA private key (PEM). */
  private_key_pem: string;
  /**
   * WeChat platform certificate public key (PEM). When present, every
   * response signature is verified; when absent, verification is skipped
   * (relies on HTTPS transport integrity — first-version fallback).
   */
  platform_public_key_pem?: string;
  /** Base URL; defaults to {@link WECHAT_API_BASE}. */
  api_base?: string;
}

/**
 * Error thrown for any non-2xx v3 response.
 *
 * `code` is the WeChat business error code (e.g. `ORDERNOTEXIST`,
 * `PARAM_ERROR`); `status` is the HTTP status.
 */
export class WechatApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'WechatApiError';
    this.status = status;
    this.code = code;
  }
}

/** Successful v3 call result: HTTP status + parsed JSON body (empty object for 204). */
export interface WechatV3Response {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Call a WeChat Pay v3 endpoint.
 *
 * @param method   HTTP verb (`GET` / `POST`)
 * @param urlPath  Path **plus query string** (e.g.
 *                 `/v3/pay/transactions/out-trade-no/X?mchid=Y`). This exact
 *                 string is what gets signed.
 * @param body     Business object for POST; `null` for GET / no-body.
 * @param config   Credentials + endpoint.
 * @returns        `{ status, body }` for 2xx responses.
 * @throws {WechatApiError} on non-2xx, or {@link Error} on transport/parse
 *         failure or a failed response-signature check.
 */
export async function wechatV3Call(
  method: 'GET' | 'POST',
  urlPath: string,
  body: Record<string, unknown> | null,
  config: WechatV3Config,
): Promise<WechatV3Response> {
  const base = config.api_base ?? WECHAT_API_BASE;
  const bodyStr = body === null ? '' : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = generateNonce();

  const signature = wechatV3Sign(
    method,
    urlPath,
    timestamp,
    nonce,
    bodyStr,
    config.private_key_pem,
  );
  const authorization = buildAuthorizationToken({
    mchid: config.mchid,
    serialNo: config.serial_no,
    nonce,
    timestamp,
    signature,
  });

  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      // WeChat requires a non-empty UA; some edge nodes 403 a blank one.
      'User-Agent': 'moltspay-wechat/1.0',
    },
    body: method === 'GET' ? undefined : bodyStr,
  });

  const text = await response.text();

  // Optional response-signature verification (resp headers + raw body).
  if (config.platform_public_key_pem && text.length > 0) {
    const ts = response.headers.get('Wechatpay-Timestamp');
    const nc = response.headers.get('Wechatpay-Nonce');
    const sig = response.headers.get('Wechatpay-Signature');
    if (!ts || !nc || !sig) {
      throw new Error(
        `WeChat v3 ${method} ${urlPath}: response missing Wechatpay-Signature headers`,
      );
    }
    if (!wechatV3VerifyResponse(ts, nc, text, sig, config.platform_public_key_pem)) {
      throw new Error(
        `WeChat v3 ${method} ${urlPath}: response signature verification failed`,
      );
    }
  }

  let json: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(
        `WeChat v3 ${method} ${urlPath}: non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`,
      );
    }
  }

  if (!response.ok) {
    const code = typeof json.code === 'string' ? json.code : undefined;
    const message = typeof json.message === 'string' ? json.message : text.slice(0, 300);
    throw new WechatApiError(
      `WeChat v3 ${method} ${urlPath} failed: HTTP ${response.status}${code ? ` ${code}` : ''}: ${message}`,
      response.status,
      code,
    );
  }

  return { status: response.status, body: json };
}
