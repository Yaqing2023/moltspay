#!/usr/bin/env node
/**
 * verify-web-bundle.mjs
 *
 * Post-build guardrail for the Web Client bundle. Runs as part of
 * `prepublishOnly` — failure blocks publish.
 *
 * Checks, in order:
 *  1. `dist/client/web/index.mjs` and its `.d.ts` exist.
 *  2. The bundle does NOT statically import any Node-only module
 *     (`require(`, `from "fs"`, `from "os"`, etc.). The `core/base64.ts`
 *     Buffer fallback is runtime-detected via `globalThis.Buffer`, so
 *     the literal string `Buffer` appearing at the property-access site
 *     is allowed — what we forbid is the import itself.
 *  3. The bundle does NOT reference `process.platform`, `__dirname`,
 *     `require(`, or `homedir(` (the CLI-only wallet-location helpers).
 *  4. The bundle size is within budget: soft-warn at 150 KB, hard-fail
 *     at 250 KB gzipped-equivalent (we measure raw bytes — the actual
 *     gzipped size is always smaller, so if raw <250 KB we're fine).
 *
 * The script exits 0 on success, 1 on any failure. Messages go to stderr.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const bundlePath = resolve(projectRoot, 'dist/client/web/index.mjs');
// tsup emits `.d.mts` alongside `.mjs` when the web config format is `['esm']`.
const typesPath = resolve(projectRoot, 'dist/client/web/index.d.mts');

const SOFT_WARN_BYTES = 150 * 1024;
const HARD_FAIL_BYTES = 250 * 1024;

/**
 * Forbidden source patterns. Each entry is `{ pattern, description, allowIn? }`.
 *
 * `allowIn` lets us permit a specific snippet to appear — used for the
 * `Buffer` runtime-detection sites in `core/base64.ts`, which do NOT import
 * Buffer but read `globalThis.Buffer` defensively.
 */
const FORBIDDEN = [
  {
    pattern: /from\s+["']fs["']/g,
    description: 'static import of "fs"',
  },
  {
    pattern: /from\s+["']os["']/g,
    description: 'static import of "os"',
  },
  {
    pattern: /from\s+["']path["']/g,
    description: 'static import of "path"',
  },
  {
    pattern: /from\s+["']crypto["']/g,
    description: 'static import of "crypto"',
  },
  {
    pattern: /from\s+["']stream["']/g,
    description: 'static import of "stream"',
  },
  {
    pattern: /from\s+["']http["']/g,
    description: 'static import of "http"',
  },
  {
    pattern: /from\s+["']https["']/g,
    description: 'static import of "https"',
  },
  {
    pattern: /from\s+["']node:[a-z]+["']/g,
    description: 'static import of a "node:" built-in',
  },
  {
    pattern: /\brequire\s*\(/g,
    description: 'CommonJS `require(` call (esm-only bundle expected)',
  },
  {
    pattern: /\bprocess\.platform\b/g,
    description: 'reference to `process.platform`',
  },
  {
    pattern: /\b__dirname\b/g,
    description: 'reference to `__dirname`',
  },
  {
    pattern: /\b__filename\b/g,
    description: 'reference to `__filename`',
  },
  {
    pattern: /\bhomedir\s*\(/g,
    description: '`homedir()` call — belongs to the Node CLI only',
  },
  {
    pattern: /\bexistsSync\s*\(/g,
    description: '`existsSync()` call — filesystem access',
  },
  {
    pattern: /\breadFileSync\s*\(/g,
    description: '`readFileSync()` call — filesystem access',
  },
  {
    pattern: /\bwriteFileSync\s*\(/g,
    description: '`writeFileSync()` call — filesystem access',
  },
];

function fail(msg) {
  console.error(`[31m✗ ${msg}[0m`);
}

function warn(msg) {
  console.error(`[33m! ${msg}[0m`);
}

function ok(msg) {
  console.error(`[32m✓ ${msg}[0m`);
}

function main() {
  let failures = 0;

  if (!existsSync(bundlePath)) {
    fail(`Web bundle not found at ${bundlePath}`);
    fail('Run `npm run build` first.');
    process.exit(1);
  }

  if (!existsSync(typesPath)) {
    fail(`Web .d.ts not found at ${typesPath}`);
    failures++;
  } else {
    ok(`Types emitted: ${typesPath.replace(projectRoot + '/', '')}`);
  }

  const source = readFileSync(bundlePath, 'utf-8');
  const size = statSync(bundlePath).size;

  for (const { pattern, description } of FORBIDDEN) {
    const matches = source.match(pattern);
    if (!matches) continue;

    // Print up to 3 offending lines for quick diagnosis.
    const lines = source.split('\n');
    const hits = [];
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        hits.push({ line: i + 1, text: line.trim().slice(0, 120) });
        pattern.lastIndex = 0;
      }
    });
    fail(`Forbidden: ${description} (${matches.length} occurrence${matches.length === 1 ? '' : 's'})`);
    hits.slice(0, 3).forEach((h) => {
      console.error(`    ${bundlePath.replace(projectRoot + '/', '')}:${h.line}  ${h.text}`);
    });
    failures++;
  }

  if (failures === 0) {
    ok('No Node-only APIs found in the Web bundle');
  }

  const kb = (size / 1024).toFixed(1);
  if (size > HARD_FAIL_BYTES) {
    fail(`Bundle size ${kb} KB exceeds hard budget ${HARD_FAIL_BYTES / 1024} KB — refusing to publish`);
    failures++;
  } else if (size > SOFT_WARN_BYTES) {
    warn(`Bundle size ${kb} KB exceeds soft budget ${SOFT_WARN_BYTES / 1024} KB (hard: ${HARD_FAIL_BYTES / 1024} KB)`);
  } else {
    ok(`Bundle size ${kb} KB (soft: ${SOFT_WARN_BYTES / 1024} KB, hard: ${HARD_FAIL_BYTES / 1024} KB)`);
  }

  if (failures > 0) {
    fail(`Web bundle verification failed with ${failures} issue${failures === 1 ? '' : 's'}`);
    process.exit(1);
  }
  ok('Web bundle verification passed');
}

main();
