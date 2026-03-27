declare module '@x402/evm/exact/client' {
  export function registerExactEvmScheme(
    client: any,
    options: { signer: any }
  ): void;
}
