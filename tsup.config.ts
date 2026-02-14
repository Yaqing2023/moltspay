import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'wallet/index': 'src/wallet/index.ts',
    'permit/index': 'src/permit/index.ts',
    'chains/index': 'src/chains/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['ethers'],
});
