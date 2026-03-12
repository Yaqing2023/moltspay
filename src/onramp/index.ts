/**
 * Coinbase Pay Integration
 * 
 * Generate URLs for users to buy USDC with fiat (debit card / Apple Pay)
 * via Coinbase Pay (US only, no Coinbase account needed)
 */

/**
 * Generate Coinbase Pay URL
 */
export function generateOnrampUrl(params: {
  destinationAddress: string;
  amount: number;
  chain?: 'base' | 'polygon';
}): string {
  const chain = params.chain || 'base';
  
  const addresses = JSON.stringify({
    [params.destinationAddress]: [chain]
  });
  
  const queryParams = new URLSearchParams({
    addresses,
    assets: JSON.stringify(['USDC']),
    presetFiatAmount: params.amount.toString(),
  });
  
  return `https://pay.coinbase.com/buy/select-asset?${queryParams.toString()}`;
}

/**
 * Print QR code to terminal
 */
export async function printQRCode(url: string): Promise<void> {
  const qrcodeModule = await import('qrcode-terminal');
  const qrcode = qrcodeModule.default || qrcodeModule;
  
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (qr: string) => {
      console.log(qr);
      resolve();
    });
  });
}
