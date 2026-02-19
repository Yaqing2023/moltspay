import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server/index.ts',
    'src/client/index.ts',
    'src/cli/index.ts',
    'src/chains/index.ts',
    'src/wallet/index.ts',
    'src/verify/index.ts',
    'src/cdp/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
});
