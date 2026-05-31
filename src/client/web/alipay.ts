/**
 * Browser stub for the Alipay rail (design §5.2.7).
 *
 * The Alipay rail is driven by the `alipay-bot` Node CLI, which cannot run in
 * a browser. 1.7.0 deliberately ships no real Web implementation rather than a
 * fake promise — the cashier-URL fallback (skill guide §6) is slated for
 * 1.7.1 / 1.8.0. This stub exists so the Web bundle can reference the rail and
 * fail loudly with a stable, actionable error instead of a missing import.
 *
 * IMPORTANT: this file must NOT import `../alipay/*` — those modules pull in
 * Node `child_process`/`fs` and would break the browser bundle.
 */

import { UnsupportedChainError } from '../core/errors.js';

export class AlipayWebClient {
  async pay(): Promise<never> {
    throw new UnsupportedChainError(
      'alipay',
      'alipay rail is not available in the browser; use the Node CLI (moltspay pay --rail alipay) or wait for v1.8.0',
    );
  }
}
