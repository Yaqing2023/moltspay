/**
 * Solana Wallet Management
 * 
 * Separate from EVM wallets - uses ed25519 keypairs.
 * Stored in ~/.moltspay/wallet-solana.json
 */

import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import bs58 from 'bs58';
import { getSolanaConnection, getUSDCMint, type SolanaChainName } from '../chains/solana.js';

const DEFAULT_CONFIG_DIR = join(homedir(), '.moltspay');
const SOLANA_WALLET_FILE = 'wallet-solana.json';

export interface SolanaWalletData {
  publicKey: string;  // Base58 encoded
  secretKey: string;  // Base58 encoded (should be encrypted in production)
  createdAt: string;
}

/**
 * Get the path to the Solana wallet file
 */
export function getSolanaWalletPath(configDir: string = DEFAULT_CONFIG_DIR): string {
  return join(configDir, SOLANA_WALLET_FILE);
}

/**
 * Check if Solana wallet exists
 */
export function solanaWalletExists(configDir: string = DEFAULT_CONFIG_DIR): boolean {
  return existsSync(getSolanaWalletPath(configDir));
}

/**
 * Load existing Solana wallet
 */
export function loadSolanaWallet(configDir: string = DEFAULT_CONFIG_DIR): Keypair | null {
  const walletPath = getSolanaWalletPath(configDir);
  
  if (!existsSync(walletPath)) {
    return null;
  }
  
  try {
    const data: SolanaWalletData = JSON.parse(readFileSync(walletPath, 'utf-8'));
    const secretKey = bs58.decode(data.secretKey);
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    console.error('Failed to load Solana wallet:', error);
    return null;
  }
}

/**
 * Create new Solana wallet
 */
export function createSolanaWallet(configDir: string = DEFAULT_CONFIG_DIR): Keypair {
  // Ensure config directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  
  const keypair = Keypair.generate();
  const data: SolanaWalletData = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    createdAt: new Date().toISOString(),
  };
  
  const walletPath = getSolanaWalletPath(configDir);
  writeFileSync(walletPath, JSON.stringify(data, null, 2));
  
  return keypair;
}

/**
 * Get Solana wallet address (public key as Base58)
 */
export function getSolanaAddress(configDir: string = DEFAULT_CONFIG_DIR): string | null {
  const wallet = loadSolanaWallet(configDir);
  return wallet?.publicKey.toBase58() || null;
}

/**
 * Get SOL balance (native token for gas)
 */
export async function getSolanaBalance(
  address: string,
  chain: SolanaChainName
): Promise<number> {
  const connection = getSolanaConnection(chain);
  const pubkey = new PublicKey(address);
  
  const balance = await connection.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Get USDC balance on Solana
 */
export async function getSolanaUSDCBalance(
  address: string,
  chain: SolanaChainName
): Promise<number> {
  const connection = getSolanaConnection(chain);
  const owner = new PublicKey(address);
  const mint = getUSDCMint(chain);
  
  try {
    const ata = await getAssociatedTokenAddress(mint, owner);
    const account = await getAccount(connection, ata);
    // USDC has 6 decimals on Solana
    return Number(account.amount) / 1e6;
  } catch (error: any) {
    // Account doesn't exist = 0 balance
    if (error.name === 'TokenAccountNotFoundError' || 
        error.message?.includes('could not find account')) {
      return 0;
    }
    throw error;
  }
}

/**
 * Get all Solana balances (SOL + USDC)
 */
export async function getSolanaBalances(
  address: string,
  chain: SolanaChainName
): Promise<{ sol: number; usdc: number }> {
  const [sol, usdc] = await Promise.all([
    getSolanaBalance(address, chain),
    getSolanaUSDCBalance(address, chain),
  ]);
  
  return { sol, usdc };
}

/**
 * Request SOL airdrop (devnet only)
 */
export async function requestSolanaAirdrop(
  address: string,
  chain: SolanaChainName,
  amount: number = 1
): Promise<string> {
  if (chain !== 'solana_devnet') {
    throw new Error('Airdrop only available on devnet');
  }
  
  const connection = getSolanaConnection(chain);
  const pubkey = new PublicKey(address);
  
  const signature = await connection.requestAirdrop(
    pubkey,
    amount * LAMPORTS_PER_SOL
  );
  
  // Wait for confirmation
  await connection.confirmTransaction(signature, 'confirmed');
  
  return signature;
}

/**
 * Validate Solana address format
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}
