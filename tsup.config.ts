import { defineConfig } from 'tsup';

/**
 * Dual-config build.
 *
 * The Node build (first block) is the existing tsup pipeline — cjs + esm,
 * platform-default, shims on. It produces every CLI / server / facilitator
 * artifact the 1.5.x package already shipped.
 *
 * The Web build (second block) is new in 1.6.0. It compiles only
 * `src/client/web/index.ts` with `platform: 'browser'` so esbuild picks
 * browser-condition imports, refuses Node built-ins, and omits the cjs
 * helpers that would otherwise appear via `shims: true`. The `external`
 * list is defence in depth: any import of `node:*`, `fs`, `os`, `path`,
 * etc. gets flagged at bundle time instead of pulling in a polyfill.
 *
 * Final artifact: `dist/client/web/index.mjs` (+ `.d.ts`). This is what
 * `moltspay/web` resolves to via the `./web` subpath export in package.json.
 */
export default defineConfig([
  // ----- Node build (existing) -----
  {
    entry: [
      'src/index.ts',
      'src/server/index.ts',
      'src/client/index.ts',
      'src/cli/index.ts',
      'src/mcp/index.ts',
      'src/chains/index.ts',
      'src/wallet/index.ts',
      'src/verify/index.ts',
      'src/cdp/index.ts',
      'src/facilitators/index.ts',
    ],
    format: ['cjs', 'esm'],
    dts: true,
    // `clean` is intentionally OFF here. tsup runs array configs in parallel,
    // so per-config `clean: true` can wipe a sibling config's already-emitted
    // artifacts (observed on tsup 8.5.1: Node config's clean racing Web DTS).
    // `npm run build` cleans dist/ via the `prebuild` script instead.
    clean: false,
    splitting: false,
    sourcemap: true,
    shims: true,
  },

  // ----- Web build (new in 1.6.0) -----
  {
    entry: { 'client/web/index': 'src/client/web/index.ts' },
    format: ['esm'],
    target: 'es2020',
    platform: 'browser',
    dts: true,
    sourcemap: true,
    splitting: false,
    // `shims: false` — we don't want the CJS/ESM interop shim injected into
    // a browser bundle. The core modules already detect `Buffer` at runtime
    // and fall back to `btoa`/`atob`, so no Node polyfill is needed.
    shims: false,
    // Fail loudly if anything pulls in a Node built-in. Any hit here is a
    // bug in the core extraction — the fix belongs in source, not here.
    external: [
      'node:*',
      'fs',
      'os',
      'path',
      'crypto',
      'stream',
      'http',
      'https',
      'url',
      'util',
      'child_process',
      'worker_threads',
    ],
    esbuildOptions(options) {
      options.conditions = ['browser', 'import', 'default'];
    },
    outExtension() {
      return { js: '.mjs' };
    },
  },
]);
