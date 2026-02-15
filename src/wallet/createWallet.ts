/**
 * createWallet - 为 Agent 创建新钱包
 * 
 * 功能：
 * - 生成新的以太坊钱包
 * - 安全存储私钥（加密或明文，取决于配置）
 * - 返回钱包地址（不返回私钥）
 */

import { ethers } from 'ethers';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

export interface CreateWalletOptions {
  /** 存储路径，默认 ~/.moltspay/wallet.json */
  storagePath?: string;
  /** 加密密码（可选，不提供则明文存储） */
  password?: string;
  /** 钱包标签/名称 */
  label?: string;
  /** 如果钱包已存在，是否覆盖 */
  overwrite?: boolean;
}

export interface WalletData {
  address: string;
  label?: string;
  createdAt: string;
  encrypted: boolean;
  /** 加密后的私钥或明文私钥 */
  privateKey: string;
  /** 加密用的 IV */
  iv?: string;
  /** 加密用的 salt */
  salt?: string;
}

export interface CreateWalletResult {
  success: boolean;
  address?: string;
  storagePath?: string;
  error?: string;
  /** 是否是新创建的（false 表示加载了已有钱包） */
  isNew?: boolean;
}

const DEFAULT_STORAGE_DIR = join(process.env.HOME || '~', '.moltspay');
const DEFAULT_STORAGE_FILE = 'wallet.json';

/**
 * 加密私钥
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
 * 解密私钥
 */
function decryptPrivateKey(encrypted: string, password: string, iv: string, salt: string): string {
  const key = scryptSync(password, Buffer.from(salt, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * 创建新钱包
 * 
 * @example
 * ```typescript
 * // 创建未加密钱包
 * const result = await createWallet();
 * console.log('钱包地址:', result.address);
 * 
 * // 创建加密钱包
 * const result = await createWallet({ password: 'mySecurePassword' });
 * 
 * // 指定存储路径
 * const result = await createWallet({ storagePath: './my-wallet.json' });
 * ```
 */
export function createWallet(options: CreateWalletOptions = {}): CreateWalletResult {
  const storagePath = options.storagePath || join(DEFAULT_STORAGE_DIR, DEFAULT_STORAGE_FILE);
  
  // 检查是否已存在
  if (existsSync(storagePath) && !options.overwrite) {
    // 加载已有钱包
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
    // 创建新钱包
    const wallet = ethers.Wallet.createRandom();
    
    // 准备存储数据
    const walletData: WalletData = {
      address: wallet.address,
      label: options.label,
      createdAt: new Date().toISOString(),
      encrypted: !!options.password,
      privateKey: '',
    };

    if (options.password) {
      // 加密存储
      const { encrypted, iv, salt } = encryptPrivateKey(wallet.privateKey, options.password);
      walletData.privateKey = encrypted;
      walletData.iv = iv;
      walletData.salt = salt;
    } else {
      // 明文存储（不推荐，但对于测试/开发方便）
      walletData.privateKey = wallet.privateKey;
    }

    // 确保目录存在
    const dir = dirname(storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 写入文件
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
 * 加载已有钱包
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
 * 获取钱包地址（不需要密码）
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
 * 检查钱包是否存在
 */
export function walletExists(storagePath?: string): boolean {
  const path = storagePath || join(DEFAULT_STORAGE_DIR, DEFAULT_STORAGE_FILE);
  return existsSync(path);
}
