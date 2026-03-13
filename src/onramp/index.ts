/**
 * Coinbase Pay Integration
 * 
 * Generate session token and URL for users to buy USDC with fiat
 * via Coinbase Pay (US only, debit card / Apple Pay)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CDP_API_BASE = 'https://api.developer.coinbase.com';

interface CDPCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

/**
 * Load CDP credentials from environment or .env file
 */
function loadCredentials(): CDPCredentials | null {
  let apiKeyId = process.env.CDP_API_KEY_ID;
  let apiKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!apiKeyId || !apiKeySecret) {
    const envPath = join(homedir(), '.moltspay', '.env');
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=').trim();
        if (key === 'CDP_API_KEY_ID') apiKeyId = value;
        if (key === 'CDP_API_KEY_SECRET') apiKeySecret = value;
      }
    }
  }

  if (!apiKeyId || !apiKeySecret) {
    return null;
  }

  return { apiKeyId, apiKeySecret };
}

/**
 * Get public IP address
 */
async function getPublicIp(): Promise<string> {
  const response = await fetch('https://api.ipify.org');
  if (!response.ok) {
    throw new Error('Failed to get public IP');
  }
  return (await response.text()).trim();
}

/**
 * Generate JWT for CDP API authentication
 */
async function generateCdpJwt(
  credentials: CDPCredentials,
  method: string,
  path: string
): Promise<string> {
  const { SignJWT, importJWK } = await import('jose');
  const crypto = await import('crypto');

  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');

  // URI format: "METHOD host/path" (no https://)
  const uri = `${method} api.developer.coinbase.com${path}`;

  const claims = {
    sub: credentials.apiKeyId,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri,
  };

  // Ed25519 key: 64 bytes = 32 seed + 32 public
  const decoded = Buffer.from(credentials.apiKeySecret, 'base64');
  const seed = decoded.subarray(0, 32);
  const publicKey = decoded.subarray(32);

  const jwk = {
    kty: 'OKP' as const,
    crv: 'Ed25519' as const,
    d: seed.toString('base64url'),
    x: publicKey.toString('base64url'),
  };

  const key = await importJWK(jwk, 'EdDSA');

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: credentials.apiKeyId, typ: 'JWT', nonce })
    .sign(key);
}

/**
 * Get session token from CDP Onramp API
 */
async function getSessionToken(params: {
  address: string;
  chain: 'base' | 'polygon';
  clientIp: string;
}): Promise<{ token: string; channelId: string }> {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new Error('CDP credentials not found. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET.');
  }

  const path = '/onramp/v1/token';
  const jwt = await generateCdpJwt(credentials, 'POST', path);

  const response = await fetch(`${CDP_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      addresses: [
        {
          address: params.address,
          blockchains: [params.chain],
        },
      ],
      clientIp: params.clientIp,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CDP API error (${response.status}): ${errorText}`);
  }

  const result = await response.json() as { token: string; channel_id: string };
  return {
    token: result.token,
    channelId: result.channel_id,
  };
}

/**
 * Generate Coinbase Pay URL with session token
 */
export async function generateOnrampUrl(params: {
  destinationAddress: string;
  amount: number;
  chain?: 'base' | 'polygon';
}): Promise<string> {
  const chain = params.chain || 'base';

  // Get public IP
  const clientIp = await getPublicIp();

  // Get session token
  const { token } = await getSessionToken({
    address: params.destinationAddress,
    chain,
    clientIp,
  });

  // Build URL with session token
  const queryParams = new URLSearchParams({
    sessionToken: token,
    defaultAsset: 'USDC',
    defaultNetwork: chain,
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
