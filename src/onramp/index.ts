/**
 * Coinbase Pay Integration
 * 
 * Generate session token and URL for users to buy USDC with fiat
 * via Coinbase Pay (US only, debit card / Apple Pay)
 */

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { deflateSync } from 'zlib';

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

interface QRCodeVendor {
  addData(input: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

interface QRCodePngOptions {
  dir?: string;
  filename?: string;
  scale?: number;
  margin?: number;
}

function qrMatrix(input: string): boolean[][] {
  const QRCode = require('qrcode-terminal/vendor/QRCode') as new (
    typeNumber: number,
    errorCorrectLevel: number,
  ) => QRCodeVendor;
  const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as {
    L: number;
  };
  const qrcode = new QRCode(-1, QRErrorCorrectLevel.L);
  qrcode.addData(input);
  qrcode.make();

  const count = qrcode.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qrcode.isDark(row, col)),
  );
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Render a QR payload as a PNG image and return the written file path.
 */
export function writeQRCodePng(input: string, opts: QRCodePngOptions = {}): string {
  const scale = opts.scale ?? 8;
  const margin = opts.margin ?? 4;
  const matrix = qrMatrix(input);
  const modules = matrix.length;
  const width = (modules + margin * 2) * scale;
  const rgba = Buffer.alloc(width * width * 4, 255);

  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const moduleX = Math.floor(x / scale) - margin;
      const moduleY = Math.floor(y / scale) - margin;
      const dark = moduleX >= 0 && moduleY >= 0 && moduleX < modules && moduleY < modules
        ? matrix[moduleY][moduleX]
        : false;
      if (dark) {
        const idx = (y * width + x) * 4;
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
      }
    }
  }

  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'moltspay-wechat-qr-'));
  const filename = opts.filename ?? 'wechat-pay-qr.png';
  const path = join(dir, filename.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  writeFileSync(path, encodePngRgba(width, width, rgba));
  return path;
}
