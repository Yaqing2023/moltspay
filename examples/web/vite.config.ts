import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * The demo imports `moltspay/web` as if it were a regular published subpath
 * export. During development we resolve that to the source tree directly so
 * a developer can edit `src/client/web/` and see changes without rebuilding.
 *
 * When you run `npm run build` in the parent (`moltspay`), the alias still
 * works because `../../dist/client/web/index.mjs` is what `moltspay/web`
 * points at via the `./web` exports field in `../../package.json`. Vite's
 * alias wins for simpler DX; comment it out if you want to test the built
 * artifact.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'moltspay/web': resolve(__dirname, '../../src/client/web/index.ts'),
    },
  },
  // `@solana/web3.js` and friends pre-bundle faster when Vite knows about them.
  optimizeDeps: {
    include: [
      '@solana/web3.js',
      '@solana/spl-token',
      '@solana/wallet-adapter-react',
      '@solana/wallet-adapter-wallets',
      'react',
      'react-dom',
    ],
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
