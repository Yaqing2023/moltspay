import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import * as readline from 'readline';
import { ethers } from 'ethers';
import { CHAINS } from '../chains/index.js';
import { MoltsPayClient } from '../client/index.js';

/** Native gas token symbol per EVM chain (for send preflight/output). */
export const GAS_SYMBOL: Record<string, string> = {
  base: 'ETH', base_sepolia: 'ETH', tempo_moderato: 'ETH',
  polygon: 'POL', bnb: 'BNB', bnb_testnet: 'BNB',
};

// Server wallet for BNB gas sponsorship (loaded from env)
export const BNB_SPONSOR_KEY = process.env.MOLTSPAY_BNB_SPONSOR_KEY;
// Server wallet address that will call transferFrom (for pay-for-success)
export const BNB_SPENDER_ADDRESS = process.env.MOLTSPAY_BNB_SPENDER || '0xEBB45208D806A0c73F9673E0c5713FF720DD6b79';

export const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export const DEFAULT_CONFIG_DIR = join(homedir(), '.moltspay');
export const PID_FILE = join(DEFAULT_CONFIG_DIR, 'server.pid');

/**
 * Set up BNB chain approvals for pay-for-success flow
 * This allows the server to call transferFrom after service succeeds
 */
export async function setupBNBApprovals(
  client: MoltsPayClient, 
  chain: 'bnb' | 'bnb_testnet',
  spenderAddress: string,
  sponsorGas: boolean = false
): Promise<void> {
  const chainConfig = CHAINS[chain];
  const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
  
  // Get wallet from client
  const wallet = client.getWallet();
  if (!wallet) {
    console.log('   ❌ No wallet found');
    return;
  }
  const signer = wallet.connect(provider);
  
  console.log(`   Spender: ${spenderAddress}`);
  
  // Check BNB balance for gas
  let bnbBalance = await provider.getBalance(wallet.address);
  const minGasRequired = ethers.parseEther('0.0005'); // ~0.0002 per approval × 2 + buffer
  
  if (bnbBalance < minGasRequired) {
    if (sponsorGas && BNB_SPONSOR_KEY) {
      console.log('   ⏳ Sponsoring BNB gas for approvals...');
      try {
        const sponsorWallet = new ethers.Wallet(BNB_SPONSOR_KEY, provider);
        const tx = await sponsorWallet.sendTransaction({
          to: wallet.address,
          value: ethers.parseEther('0.001'),
        });
        await tx.wait();
        console.log(`   ✅ Sponsored 0.001 BNB (tx: ${tx.hash.slice(0, 10)}...)`);
        bnbBalance = await provider.getBalance(wallet.address);
      } catch (err: any) {
        console.log(`   ⚠️  Gas sponsorship failed: ${err.message}`);
        console.log(`   💡 Get testnet BNB: https://testnet.bnbchain.org/faucet-smart`);
        return;
      }
    } else {
      console.log(`   ⚠️  Need BNB for gas (~0.0005 BNB)`);
      console.log(`   💡 Run: moltspay faucet --chain bnb_testnet`);
      console.log(`   Then run: moltspay approve --chain ${chain} --spender ${spenderAddress}`);
      return;
    }
  }
  
  // Approve USDT and USDC for the spender address
  for (const tokenSymbol of ['USDT', 'USDC'] as const) {
    const tokenConfig = chainConfig.tokens[tokenSymbol];
    const tokenContract = new ethers.Contract(tokenConfig.address, ERC20_APPROVE_ABI, signer);
    
    // Check existing allowance
    const allowance = await tokenContract.allowance(wallet.address, spenderAddress);
    if (allowance > 0n) {
      console.log(`   ✅ ${tokenSymbol}: already approved for ${spenderAddress.slice(0, 10)}...`);
      continue;
    }
    
    console.log(`   ⏳ Approving ${tokenSymbol}...`);
    try {
      const tx = await tokenContract.approve(spenderAddress, ethers.MaxUint256);
      await tx.wait();
      console.log(`   ✅ ${tokenSymbol}: approved (tx: ${tx.hash.slice(0, 10)}...)`);
    } catch (err: any) {
      console.log(`   ❌ ${tokenSymbol}: approval failed - ${err.message}`);
    }
  }
  
  console.log('');
}

/**
 * Check BNB approval status
 */
export async function checkBNBApprovals(
  address: string,
  chain: 'bnb' | 'bnb_testnet',
  configDir: string = DEFAULT_CONFIG_DIR
): Promise<{ usdt: boolean; usdc: boolean; spender: string | null }> {
  const chainConfig = CHAINS[chain];
  const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
  
  // Read spender from wallet config (saved during approve command)
  let spenderAddress: string | null = null;
  try {
    const walletPath = join(configDir, 'wallet.json');
    const walletData = JSON.parse(readFileSync(walletPath, 'utf-8'));
    spenderAddress = walletData.approvals?.[chain] || null;
  } catch {
    // No saved spender
  }
  
  const result = { usdt: false, usdc: false, spender: spenderAddress };
  
  if (!spenderAddress) {
    return result; // No spender saved, can't check approvals
  }
  
  for (const tokenSymbol of ['USDT', 'USDC'] as const) {
    const tokenConfig = chainConfig.tokens[tokenSymbol];
    const tokenContract = new ethers.Contract(tokenConfig.address, ERC20_APPROVE_ABI, provider);
    const allowance = await tokenContract.allowance(address, spenderAddress);
    result[tokenSymbol.toLowerCase() as 'usdt' | 'usdc'] = allowance > 0n;
  }
  
  return result;
}

export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
