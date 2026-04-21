/**
 * Backwards-compatibility re-export for `src/client/index.ts`.
 *
 * The Node client implementation moved to `./node/index.ts` in 1.6.0 as part
 * of the Web Client work (see docs/WEB-CLIENT-DESIGN.md, Phase 1).
 *
 * This file keeps `import { MoltsPayClient } from 'moltspay/client'` working
 * for existing callers and preserves the published `dist/client/index.*`
 * bundle path declared in package.json exports.
 */

export * from './node/index.js';
