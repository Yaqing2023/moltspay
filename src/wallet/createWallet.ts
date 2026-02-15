/**
 * createWallet - Create a new wallet for Agent
 * 
 * Features:
 * - Generate new Ethereum wallet
 * - Securely store private key (encrypted or plaintext, depending on config)
 * - Return wallet address (never return private key)
 */

import { ethers } from 'ethers';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

export interface CreateWalletOptions {
  /** Storage path, default ~/.moltspay/wallet.json */
  storagePath?: string;
  /** Encryption password (optional, plaintext if not provided) */
  password?: string;
  /** Wallet label/name */
  label?: string;
  /** Overwrite if wallet exists */
  overwrite?: boolean;
}

export interface WalletData {
  address: string;
  label?: string;
  createdAt: string;
  encrypted: boolean;
  /** Encrypted or plaintext private key */
  privateKey: string;
  /** Encryption IV */
  iv?: string;
  /** Encryption salt */
  salt?: string;
}

export interface CreateWalletResult {
  success: boolean;
  address?: string;
  storagePath?: string;
  error?: string;
  /** Whether newly created (false means loaded existing) */
  isNew?: boolean;
}

const DEFAULT_STORAGE_DIR = join(process.env.HOME || '~', '.moltspay');
const DEFAULT_STORAGE_FILE = 'wallet.json';

/**
 * Encrypt private key
 */
function encryptPrivateKey(privateKey: string, password: string): { encrypted: string; iv: string; salt: string } {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  const iv = randomBytes(16);
  
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
  };
}

/**
 * Decrypt private key
 */
function decryptPrivateKey(encrypted: string, password: string, iv: string, salt: string): string {
  const key = scryptSync(password, Buffer.from(salt, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Create new wallet
 * 
 * @example
 * ```typescript
 * // Create unencrypted wallet
 * const result = await createWallet();
 * console.log('Wallet address:', result.address);
 * 
 * // Create encrypted wallet
 * const result = await createWallet({ password: 'mySecurePassword' });
 * 
 * // Specify storage path
 * const result = await createWallet({ storagePath: './my-wallet.json' });
 * ```
 */
export function createWallet(options: CreateWalletOptions = {}): CreateWalletResult {
  const storagePath = options.storagePath || join(DEFAULT_STORAGE_DIR, DEFAULT_STORAGE_FILE);
  
  // Check if exists
  if (existsSync(storagePath) && !options.overwrite) {
    // Load existing wallet
    try {
      const existing = JSON.parse(readFileSync(storagePath, 'utf8')) as WalletData;
      return {
        success: true,
        address: existing.address,
        storagePath,
        isNew: false,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to load existing wallet: ${(error as Error).message}`,
      };
    }
  }

  try {
    // Create new wallet
    const wallet = ethers.Wallet.createRandom();
    
    // Prepare storage data
    const walletData: WalletData = {
      address: wallet.address,
      label: options.label,
      createdAt: new Date().toISOString(),
      encrypted: !!options.password,
      privateKey: '',
    };

    if (options.password) {
      // Encrypted storage
      const { encrypted, iv, salt } = encryptPrivateKey(wallet.privateKey, options.password);
      walletData.privateKey = encrypted;
      walletData.iv = iv;
      walletData.salt = salt;
    } else {
      // Plaintext storage (not recommended, but convenient for testing/dev)
      walletData.privateKey = wallet.privateKey;
    }

    // Ensure directory exists
    const dir = dirname(storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write file
    writeFileSync(storagePath, JSON.stringify(walletData, null, 2), { mode: 0o600 });

    return {
      success: true,
      address: wallet.address,
      storagePath,
      isNew: true,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Load existing wallet
 */
export function loadWallet(options: { storagePath?: string; password?: string } = {}): {
  success: boolean;
  address?: string;
  privateKey?: string;
  error?: string;
} {
  const storagePath = options.storagePath || join(DEFAULT_STORAGE_DIR, DEFAULT_STORAGE_FILE);

  if (!existsSync(storagePath)) {
    return { success: false, error: 'Wallet not found. Run createWallet() first.' };
  }

  try {
    const data = JSON.parse(readFileSync(storagePath, 'utf8')) as WalletData;

    if (data.encrypted) {
      if (!options.password) {
        return { success: false, error: 'Wallet is encrypted. Password required.' };
      }
      const privateKey = decryptPrivateKey(data.privateKey, options.password, data.iv!, data.salt!);
      return { success: true, address: data.address, privateKey };
    } else {
      return { success: true, address: data.address, privateKey: data.privateKey };
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Get wallet address (no password required)
 */
export function getWalletAddress(storagePath?: string): string | null {
  const path = storagePath || join(DEFAULT_STORAGE_DIR, DEFAULT_STORAGE_FILE);
  
  if (!existsSync(path)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as WalletData;
    return data.address;
  } catch {
    return null;
  }
}

/**
 * Check if wallet exists
 */
export function walletExists(storagePath?: string): boolean {
  const path = storagePath || join(DEFAULT_STORAGE_DIR, DEFAULT_STORAGE_FILE);
  return existsSync(path);
}
