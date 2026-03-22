#!/usr/bin/env node

/**
 * MoltsPay CLI
 * 
 * Commands:
 *   npx moltspay init              - Create wallet, set limits
 *   npx moltspay config            - Update settings
 *   npx moltspay fund <amount>     - Fund wallet via Coinbase (US only)
 *   npx moltspay status            - Show wallet and balance
 *   npx moltspay services <url>    - List services from provider
 *   npx moltspay start <manifest>  - Start server from services.json
 */

// Polyfill crypto for Node.js 18
import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import { Command } from 'commander';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { ethers } from 'ethers';
import { MoltsPayClient } from '../client/index.js';
import { MoltsPayServer } from '../server/index.js';
import { printQRCode } from '../onramp/index.js';
import { CHAINS } from '../chains/index.js';
import { SOLANA_CHAINS, getSolanaExplorerUrl, getSolanaTxExplorerUrl, isSolanaChain } from '../chains/solana.js';
import { 
  loadSolanaWallet, 
  createSolanaWallet, 
  getSolanaAddress, 
  getSolanaBalances,
  solanaWalletExists,
  isValidSolanaAddress,
} from '../wallet/solana.js';
import type { ChainName } from '../types/index.js';
import * as readline from 'readline';

// Read version from package.json at runtime
function getVersion(): string {
  // Try to find package.json in common locations
  const locations = [
    join(__dirname, '../../package.json'),
    join(__dirname, '../package.json'),
    join(process.cwd(), 'node_modules/moltspay/package.json'),
  ];
  for (const loc of locations) {
    try {
      if (existsSync(loc)) {
        const pkg = JSON.parse(readFileSync(loc, 'utf-8'));
        if (pkg.name === 'moltspay') return pkg.version;
      }
    } catch { /* ignore */ }
  }
  return '0.0.0'; // fallback
}

// Server wallet for BNB gas sponsorship (loaded from env)
const BNB_SPONSOR_KEY = process.env.MOLTSPAY_BNB_SPONSOR_KEY;
// Server wallet address that will call transferFrom (for pay-for-success)
const BNB_SPENDER_ADDRESS = process.env.MOLTSPAY_BNB_SPENDER || '0xEBB45208D806A0c73F9673E0c5713FF720DD6b79';

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

/**
 * Set up BNB chain approvals for pay-for-success flow
 * This allows the server to call transferFrom after service succeeds
 */
async function setupBNBApprovals(
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
  const minGasRequired = ethers.parseEther('0.002'); // ~$0.01 for 2 approvals
  
  if (bnbBalance < minGasRequired) {
    if (sponsorGas && BNB_SPONSOR_KEY) {
      console.log('   ⏳ Sponsoring BNB gas for approvals...');
      try {
        const sponsorWallet = new ethers.Wallet(BNB_SPONSOR_KEY, provider);
        const tx = await sponsorWallet.sendTransaction({
          to: wallet.address,
          value: ethers.parseEther('0.002'),
        });
        await tx.wait();
        console.log(`   ✅ Sponsored 0.002 BNB (tx: ${tx.hash.slice(0, 10)}...)`);
        bnbBalance = await provider.getBalance(wallet.address);
      } catch (err: any) {
        console.log(`   ⚠️  Gas sponsorship failed: ${err.message}`);
        console.log(`   💡 Get testnet BNB: https://testnet.bnbchain.org/faucet-smart`);
        return;
      }
    } else {
      console.log(`   ⚠️  Need BNB for gas (~0.002 BNB)`);
      console.log(`   💡 Get testnet BNB: https://testnet.bnbchain.org/faucet-smart`);
      console.log(`   Then run: npx moltspay approve --chain ${chain} --spender ${spenderAddress}`);
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
async function checkBNBApprovals(
  address: string,
  chain: 'bnb' | 'bnb_testnet'
): Promise<{ usdt: boolean; usdc: boolean }> {
  const chainConfig = CHAINS[chain];
  const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
  
  const result = { usdt: false, usdc: false };
  
  for (const tokenSymbol of ['USDT', 'USDC'] as const) {
    const tokenConfig = chainConfig.tokens[tokenSymbol];
    const tokenContract = new ethers.Contract(tokenConfig.address, ERC20_APPROVE_ABI, provider);
    const allowance = await tokenContract.allowance(address, BNB_SPENDER_ADDRESS);
    result[tokenSymbol.toLowerCase() as 'usdt' | 'usdc'] = allowance > 0n;
  }
  
  return result;
}

const program = new Command();
const DEFAULT_CONFIG_DIR = join(homedir(), '.moltspay');
const PID_FILE = join(DEFAULT_CONFIG_DIR, 'server.pid');

// Ensure config dir exists
if (!existsSync(DEFAULT_CONFIG_DIR)) {
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
}

function prompt(question: string): Promise<string> {
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

program
  .name('moltspay')
  .description('MoltsPay - Payment infrastructure for AI Agents')
  .version(getVersion());

/**
 * npx moltspay init
 */
program
  .command('init')
  .description('Initialize MoltsPay client (create wallet, set limits)')
  .option('--chain <chain>', 'Blockchain to use', 'base')
  .option('--max-per-tx <amount>', 'Max amount per transaction')
  .option('--max-per-day <amount>', 'Max amount per day')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action(async (options) => {
    // Get chain option
    let chain = options.chain;
    
    // Validate chain
    const supportedEVMChains = ['base', 'polygon', 'base_sepolia', 'tempo_moderato', 'bnb', 'bnb_testnet'];
    const supportedSolanaChains = ['solana', 'solana_devnet'];
    const supportedChains = [...supportedEVMChains, ...supportedSolanaChains];
    
    if (!supportedChains.includes(chain)) {
      console.error(`❌ Unknown chain: ${chain}. Supported: ${supportedChains.join(', ')}`);
      process.exit(1);
    }
    
    // Handle Solana chains separately (different wallet)
    if (supportedSolanaChains.includes(chain)) {
      console.log('\n🟣 Solana Wallet Setup\n');
      
      if (solanaWalletExists(options.configDir)) {
        const existingAddress = getSolanaAddress(options.configDir);
        console.log(`⚠️  Solana wallet already exists: ${existingAddress}`);
        console.log(`   Config dir: ${options.configDir}`);
        return;
      }
      
      console.log('Creating Solana wallet...');
      const keypair = createSolanaWallet(options.configDir);
      const address = keypair.publicKey.toBase58();
      
      console.log(`\n✅ Solana wallet created: ${address}`);
      console.log(`\n📁 Config saved to: ${join(options.configDir, 'wallet-solana.json')}`);
      console.log(`\n⚠️  IMPORTANT: Back up your wallet file!`);
      console.log(`   This file contains your private key!\n`);
      
      if (chain === 'solana_devnet') {
        console.log('💡 Get testnet tokens:');
        console.log('   npx moltspay faucet --chain solana_devnet\n');
      } else {
        console.log(`💰 Fund your wallet with USDC on Solana to start (gasless - no SOL needed).\n`);
      }
      
      return;
    }

    // For EVM chains, check if already initialized
    console.log('\n🔐 MoltsPay Client Setup\n');
    
    if (existsSync(join(options.configDir, 'wallet.json'))) {
      console.log('⚠️  EVM wallet already initialized. Use "moltspay config" to update settings.');
      console.log(`   Config dir: ${options.configDir}`);
      return;
    }
    
    let maxPerTx = options.maxPerTx ? parseFloat(options.maxPerTx) : null;
    let maxPerDay = options.maxPerDay ? parseFloat(options.maxPerDay) : null;

    if (!maxPerTx) {
      const answer = await prompt('Max per transaction (USD) [100]: ');
      maxPerTx = answer ? parseFloat(answer) : 100;
    }

    if (!maxPerDay) {
      const answer = await prompt('Max per day (USD) [1000]: ');
      maxPerDay = answer ? parseFloat(answer) : 1000;
    }

    console.log('\nCreating wallet...');

    const result = MoltsPayClient.init(options.configDir, {
      chain,
      maxPerTx,
      maxPerDay,
    });

    console.log(`\n✅ Wallet created: ${result.address}`);
    console.log(`\n📁 Config saved to: ${result.configDir}`);
    console.log(`\n⚠️  IMPORTANT: Back up ${join(result.configDir, 'wallet.json')}`);
    console.log(`   This file contains your private key!\n`);

    // For BNB chains, set up approvals (requires gas sponsorship for new wallets)
    if (chain === 'bnb' || chain === 'bnb_testnet') {
      console.log('📋 Setting up BNB chain approvals...\n');
      console.log('   ℹ️  Using default spender. For other services, run:');
      console.log(`   npx moltspay approve --chain ${chain} --spender <address>\n`);
      const client = new MoltsPayClient({ configDir: options.configDir });
      await setupBNBApprovals(client, chain, BNB_SPENDER_ADDRESS, true); // true = sponsor gas
    }

    console.log(`💰 Fund your wallet with USDC on ${chain} to start using services.\n`);
  });

/**
 * npx moltspay config
 */
program
  .command('config')
  .description('Update MoltsPay settings')
  .option('--max-per-tx <amount>', 'Max amount per transaction')
  .option('--max-per-day <amount>', 'Max amount per day')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action(async (options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });

    if (!client.isInitialized) {
      console.log('❌ Not initialized. Run: npx moltspay init');
      return;
    }

    const currentConfig = client.getConfig();

    // If no options provided, show interactive mode
    if (!options.maxPerTx && !options.maxPerDay) {
      console.log('\n📋 Current Settings:\n');
      console.log(`   Wallet: ${client.address}`);
      console.log(`   Chain: ${currentConfig.chain}`);
      console.log(`   Max per tx: $${currentConfig.limits.maxPerTx}`);
      console.log(`   Max per day: $${currentConfig.limits.maxPerDay}`);
      console.log('');

      const maxPerTxAnswer = await prompt(`New max per tx (USD) [${currentConfig.limits.maxPerTx}]: `);
      const maxPerDayAnswer = await prompt(`New max per day (USD) [${currentConfig.limits.maxPerDay}]: `);

      if (maxPerTxAnswer) {
        client.updateConfig({ maxPerTx: parseFloat(maxPerTxAnswer) });
        console.log(`✅ Updated max per tx to $${maxPerTxAnswer}`);
      }

      if (maxPerDayAnswer) {
        client.updateConfig({ maxPerDay: parseFloat(maxPerDayAnswer) });
        console.log(`✅ Updated max per day to $${maxPerDayAnswer}`);
      }
    } else {
      // Non-interactive mode
      if (options.maxPerTx) {
        client.updateConfig({ maxPerTx: parseFloat(options.maxPerTx) });
        console.log(`✅ Updated max per tx to $${options.maxPerTx}`);
      }
      if (options.maxPerDay) {
        client.updateConfig({ maxPerDay: parseFloat(options.maxPerDay) });
        console.log(`✅ Updated max per day to $${options.maxPerDay}`);
      }
    }
  });

/**
 * npx moltspay fund <amount>
 * 
 * Fund wallet with USDC via Coinbase Pay
 * US residents only, debit card or Apple Pay
 */
program
  .command('fund <amount>')
  .description('Fund wallet with USDC via Coinbase (US debit card / Apple Pay)')
  .option('--chain <chain>', 'Chain to fund (base, polygon, solana, or base_sepolia)', 'base')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action(async (amountStr, options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount < 5) {
      console.log('❌ Minimum $5.');
      return;
    }

    const chain = (options.chain?.toLowerCase() || 'base') as 'base' | 'polygon' | 'base_sepolia' | 'solana';
    if (!['base', 'polygon', 'base_sepolia', 'solana'].includes(chain)) {
      console.log('❌ Invalid chain. Use: base, polygon, solana, or base_sepolia');
      return;
    }
    
    // Determine wallet address based on chain
    let walletAddress: string;
    if (chain === 'solana') {
      // Load Solana wallet
      const solanaWallet = loadSolanaWallet(options.configDir || DEFAULT_CONFIG_DIR);
      if (!solanaWallet) {
        console.log('❌ No Solana wallet found. Run: npx moltspay init --chain solana');
        return;
      }
      walletAddress = getSolanaAddress(options.configDir || DEFAULT_CONFIG_DIR) || '';
      if (!walletAddress) {
        console.log('❌ Could not get Solana wallet address.');
        return;
      }
    } else {
      // EVM chains use the client wallet
      if (!client.isInitialized) {
        console.log('❌ Not initialized. Run: npx moltspay init');
        return;
      }
      walletAddress = client.address!;
    }
    
    // Testnet: use faucet instead of Coinbase Pay
    if (chain === 'base_sepolia') {
      console.log('\n🧪 Testnet Funding\n');
      console.log(`   Wallet: ${walletAddress}`);
      console.log(`   Chain: Base Sepolia (testnet)\n`);
      console.log('💡 Use the MoltsPay faucet to get free testnet USDC:\n');
      console.log('   npx moltspay faucet\n');
      console.log('   Or get from Circle Faucet: https://faucet.circle.com/\n');
      return;
    }

    console.log('\n💳 Fund your agent wallet\n');
    console.log(`   Wallet: ${walletAddress}`);
    console.log(`   Chain: ${chain === 'solana' ? 'Solana' : chain}`);
    console.log(`   Amount: $${amount.toFixed(2)}\n`);

    try {
      // Call server API to generate onramp URL (no local CDP keys needed)
      const ONRAMP_API = process.env.MOLTSPAY_ONRAMP_API || 'https://moltspay.com/api/v1/onramp';
      
      const response = await fetch(`${ONRAMP_API}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: walletAddress,
          amount,
          chain,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Server error' })) as { error?: string };
        throw new Error(errorData.error || `Server returned ${response.status}`);
      }

      const result = await response.json() as { url: string };
      const { url } = result;

      console.log('   Scan to pay (US debit card / Apple Pay):\n');
      await printQRCode(url);
      console.log('\n   ⏱️  QR code expires in 5 minutes\n');
    } catch (error) {
      console.log(`❌ ${(error as Error).message}`);
    }
  });

/**
 * npx moltspay approve
 * 
 * Approve a spender address for BNB chain payments (required before paying)
 */
program
  .command('approve')
  .description('Approve a spender address for BNB chain payments')
  .requiredOption('--spender <address>', 'Spender address to approve (from server 402 response)')
  .option('--chain <chain>', 'BNB chain (bnb or bnb_testnet)', 'bnb_testnet')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action(async (options) => {
    const chain = options.chain as 'bnb' | 'bnb_testnet';
    
    if (chain !== 'bnb' && chain !== 'bnb_testnet') {
      console.log('❌ approve command is only for BNB chains (bnb or bnb_testnet)');
      return;
    }
    
    if (!options.spender.match(/^0x[a-fA-F0-9]{40}$/)) {
      console.log('❌ Invalid spender address format');
      return;
    }
    
    const client = new MoltsPayClient({ configDir: options.configDir });
    if (!client.isInitialized) {
      console.log('❌ Wallet not initialized. Run: npx moltspay init --chain ' + chain);
      return;
    }
    
    console.log(`\n🔐 Approving spender for ${chain}...\n`);
    await setupBNBApprovals(client, chain, options.spender, false);
    console.log('✅ Approval complete!\n');
  });

/**
 * npx moltspay faucet
 * 
 * Request testnet tokens from faucets (Base Sepolia or Tempo Moderato)
 */
program
  .command('faucet')
  .description('Request testnet tokens from faucet (Base Sepolia, Tempo Moderato, BNB Testnet, or Solana Devnet)')
  .option('--chain <chain>', 'Chain to get tokens on (base_sepolia, tempo_moderato, bnb_testnet, or solana_devnet)', 'base_sepolia')
  .option('--address <address>', 'Wallet address (defaults to your wallet)')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action(async (options) => {
    let address = options.address;
    const chain = options.chain?.toLowerCase() || 'base_sepolia';

    // Validate chain
    if (!['base_sepolia', 'tempo_moderato', 'bnb_testnet', 'solana_devnet'].includes(chain)) {
      console.log('❌ Invalid chain. Use: base_sepolia, tempo_moderato, bnb_testnet, or solana_devnet');
      return;
    }

    // Handle Solana devnet separately
    if (chain === 'solana_devnet') {
      // Get Solana address
      if (!address) {
        address = getSolanaAddress(options.configDir);
        if (!address) {
          console.log('❌ No Solana wallet found. Run: npx moltspay init --chain solana_devnet');
          return;
        }
      }

      // Validate Solana address format
      if (!isValidSolanaAddress(address)) {
        console.log('❌ Invalid Solana address');
        return;
      }

      console.log('\n🚰 Solana Devnet Faucet (Gasless Mode)\n');
      console.log(`   Address: ${address}\n`);

      let usdcSuccess = false;

      // Request USDC from MoltsPay faucet API (no SOL needed - server pays fees)
      try {
        console.log('   ⏳ Requesting 1 USDC from faucet...');
        const FAUCET_API = process.env.MOLTSPAY_FAUCET_API || 'https://moltspay.com/api/v1/faucet';
        
        const response = await fetch(FAUCET_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, chain: 'solana_devnet' }),
        });

        const result = await response.json() as {
          success?: boolean;
          amount?: string;
          transaction?: string;
          explorer?: string;
          faucet_balance?: string;
          error?: string;
          hint?: string;
          retry_after?: string;
        };

        if (!response.ok) {
          console.log(`   ⚠️  USDC faucet: ${result.error || 'Request failed'}`);
          if (result.hint) console.log(`      ${result.hint}`);
          if (result.retry_after) console.log(`      Retry after: ${result.retry_after}`);
        } else {
          console.log(`   ✅ Received ${result.amount} USDC!`);
          console.log(`   Transaction: ${result.explorer}`);
          if (result.faucet_balance) {
            console.log(`   Faucet balance: ${result.faucet_balance} USDC remaining`);
          }
          usdcSuccess = true;
        }
      } catch (error: any) {
        console.log(`   ⚠️  USDC faucet error: ${error.message}`);
      }

      console.log('');
      if (usdcSuccess) {
        console.log('💡 Check your balance:');
        console.log('   npx moltspay status\n');
      } else {
        console.log('❌ Faucet request failed. Try again in a few minutes.\n');
      }
      return;
    }

    // If no address provided, try to use initialized EVM wallet
    if (!address) {
      const client = new MoltsPayClient({ configDir: options.configDir });
      if (client.isInitialized) {
        address = client.address;
      } else {
        console.log('❌ No wallet found. Either run "npx moltspay init" or provide --address');
        return;
      }
    }

    // Validate EVM address format
    if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
      console.log('❌ Invalid Ethereum address');
      return;
    }

    console.log('\n🚰 MoltsPay Testnet Faucet\n');

    if (chain === 'tempo_moderato') {
      // Tempo Moderato faucet
      console.log(`   Requesting testnet tokens on Tempo Moderato...`);
      console.log(`   Address: ${address}\n`);

      try {
        // Tempo docs faucet API - sends all 4 testnet tokens (pathUSD, AlphaUSD, BetaUSD, ThetaUSD)
        const TEMPO_FAUCET_API = 'https://docs.tempo.xyz/api/faucet';
        
        const response = await fetch(TEMPO_FAUCET_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        });

        const result = await response.json() as { data?: { hash: string }[]; error?: string };

        if (response.ok && result.data && result.data.length > 0) {
          console.log(`✅ Received testnet tokens!\n`);
          console.log(`   Tokens: pathUSD, AlphaUSD, BetaUSD, ThetaUSD (1M each)`);
          console.log(`   Transactions:`);
          for (const tx of result.data) {
            console.log(`     https://explore.testnet.tempo.xyz/tx/${tx.hash}`);
          }
          console.log('\n💡 Use these tokens to test MPP payments:');
          console.log(`   npx moltspay pay <service-url> <service-id> --chain tempo_moderato\n`);
        } else {
          console.log(`❌ ${result.error || 'Faucet request failed'}`);
          console.log('\n   Try again later or use Tempo Wallet: https://wallet.tempo.xyz\n');
        }
      } catch (error) {
        console.log(`❌ ${(error as Error).message}`);
        console.log('\n   Try Tempo Wallet instead: https://wallet.tempo.xyz\n');
      }
    } else if (chain === 'bnb_testnet') {
      // BNB Testnet faucet - uses unified MoltsPay faucet API
      console.log(`   Requesting 1 USDC on BNB Testnet...`);
      console.log(`   Address: ${address}\n`);

      try {
        const FAUCET_API = process.env.MOLTSPAY_FAUCET_API || 'https://moltspay.com/api/v1/faucet';
        
        const response = await fetch(FAUCET_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, chain: 'bnb_testnet' }),
        });

        const result = await response.json() as {
          success?: boolean;
          amount?: string;
          token?: string;
          chain_name?: string;
          transaction?: string;
          explorer?: string;
          faucet_balance?: string;
          error?: string;
          hint?: string;
          retry_after?: string;
        };

        if (!response.ok) {
          console.log(`❌ ${result.error || 'Request failed'}`);
          if (result.hint) console.log(`   ${result.hint}`);
          if (result.retry_after) console.log(`   Retry after: ${result.retry_after}`);
          
          // Show manual faucet instructions as fallback
          console.log('\n💡 Alternatively, get tokens manually:');
          console.log(`   1. Get test BNB: https://www.bnbchain.org/en/testnet-faucet`);
          console.log(`   2. Select "Peggy Tokens" -> USDC`);
          console.log(`   3. Enter: ${address}\n`);
          return;
        }

        console.log(`✅ Received ${result.amount} ${result.token || 'USDC'} on ${result.chain_name || 'BNB Testnet'}!\n`);
        console.log(`   Transaction: ${result.explorer || `https://testnet.bscscan.com/tx/${result.transaction}`}`);
        if (result.faucet_balance) {
          console.log(`   Faucet balance: ${result.faucet_balance} USDC`);
        }
        console.log('\n💡 Now you can test BNB payments:');
        console.log(`   npx moltspay pay <service-url> <service-id> --chain bnb_testnet\n`);
      } catch (error) {
        console.log(`❌ ${(error as Error).message}`);
        console.log('\n💡 Get tokens manually:');
        console.log(`   1. Get test BNB: https://www.bnbchain.org/en/testnet-faucet`);
        console.log(`   2. Select "Peggy Tokens" -> USDC`);
        console.log(`   3. Enter: ${address}\n`);
      }
    } else {
      // Base Sepolia faucet (existing)
      console.log(`   Requesting 1 USDC on Base Sepolia...`);
      console.log(`   Address: ${address}\n`);

      try {
        const FAUCET_API = process.env.MOLTSPAY_FAUCET_API || 'https://moltspay.com/api/v1/faucet';
        
        const response = await fetch(FAUCET_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, chain: 'base_sepolia' }),
        });

        const result = await response.json() as {
          success?: boolean;
          amount?: string;
          transaction?: string;
          explorer?: string;
          faucet_balance?: string;
          error?: string;
          hint?: string;
          retry_after?: string;
        };

        if (!response.ok) {
          console.log(`❌ ${result.error || 'Request failed'}`);
          if (result.hint) console.log(`   ${result.hint}`);
          if (result.retry_after) console.log(`   Retry after: ${result.retry_after}`);
          return;
        }

        console.log(`✅ Received ${result.amount} USDC!\n`);
        console.log(`   Transaction: ${result.transaction}`);
        console.log(`   Explorer: ${result.explorer}`);
        console.log(`   Faucet balance: ${result.faucet_balance} USDC remaining\n`);
        console.log('💡 Use this USDC to test x402 payments:');
        console.log(`   npx moltspay pay <service-url> <service-id> --chain base_sepolia\n`);
      } catch (error) {
        console.log(`❌ ${(error as Error).message}`);
      }
    }
  });

/**
 * npx moltspay status
 */
program
  .command('status')
  .description('Show wallet status and balance')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });

    if (!client.isInitialized) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'Not initialized' }));
      } else {
        console.log('❌ Not initialized. Run: npx moltspay init');
      }
      return;
    }

    const config = client.getConfig();
    
    // Get balances on all supported chains
    let allBalances: Record<string, { usdc: number; usdt: number; native: number }> = {};
    try {
      allBalances = await client.getAllBalances();
    } catch (err: any) {
      console.error('Warning: Could not fetch balances:', err.message);
    }

    // Check for Solana wallet
    const solanaAddress = getSolanaAddress(options.configDir);
    let solanaBalances: { devnet?: { sol: number; usdc: number }; mainnet?: { sol: number; usdc: number } } = {};
    
    if (solanaAddress) {
      try {
        solanaBalances.devnet = await getSolanaBalances(solanaAddress, 'solana_devnet');
      } catch { /* ignore */ }
      try {
        solanaBalances.mainnet = await getSolanaBalances(solanaAddress, 'solana');
      } catch { /* ignore */ }
    }

    if (options.json) {
      const output: any = {
        address: client.address,
        balances: allBalances,
        limits: config.limits,
      };
      if (solanaAddress) {
        output.solana = {
          address: solanaAddress,
          balances: solanaBalances,
        };
      }
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log('\n📊 MoltsPay Wallet Status\n');
      console.log(`   Address: ${client.address}`);
      console.log('');
      console.log('   Balances:');
      for (const [chainName, balance] of Object.entries(allBalances)) {
        // Format chain label nicely
        let chainLabel: string;
        if (chainName === 'base_sepolia') {
          chainLabel = 'Base Sepolia';
        } else if (chainName === 'tempo_moderato') {
          chainLabel = 'Tempo Moderato';
        } else {
          chainLabel = chainName.charAt(0).toUpperCase() + chainName.slice(1);
        }
        
        // Tempo: show all 4 testnet tokens + native balance
        if (chainName === 'tempo_moderato' && (balance as any).tempo) {
          const tempo = (balance as any).tempo;
          // Format large native balance with scientific notation if needed
          const nativeStr = balance.native > 1e12 
            ? balance.native.toExponential(2) 
            : balance.native.toFixed(2);
          console.log(`     ${chainLabel}:`);
          console.log(`       Native:    ${nativeStr} TEMPO (for gas)`);
          console.log(`       pathUSD:   ${tempo.pathUSD.toFixed(2)}`);
          console.log(`       alphaUSD:  ${tempo.alphaUSD.toFixed(2)}`);
          console.log(`       betaUSD:   ${tempo.betaUSD.toFixed(2)}`);
          console.log(`       thetaUSD:  ${tempo.thetaUSD.toFixed(2)}`);
        } else if (chainName === 'bnb' || chainName === 'bnb_testnet') {
          // BNB chains: show balance + approval status
          console.log(`     ${chainLabel.padEnd(14)} ${balance.usdc.toFixed(2)} USDC | ${balance.usdt.toFixed(2)} USDT`);
        } else {
          // EVM chains: show USDC/USDT
          console.log(`     ${chainLabel.padEnd(14)} ${balance.usdc.toFixed(2)} USDC | ${balance.usdt.toFixed(2)} USDT`);
        }
      }
      
      // Check BNB approval status
      const address = client.address!;
      let bnbApprovalStatus: { usdt: boolean; usdc: boolean } | null = null;
      let bnbTestnetApprovalStatus: { usdt: boolean; usdc: boolean } | null = null;
      
      try {
        if (allBalances['bnb']) {
          bnbApprovalStatus = await checkBNBApprovals(address, 'bnb');
        }
        if (allBalances['bnb_testnet']) {
          bnbTestnetApprovalStatus = await checkBNBApprovals(address, 'bnb_testnet');
        }
      } catch { /* ignore approval check errors */ }
      
      if (bnbApprovalStatus || bnbTestnetApprovalStatus) {
        console.log('');
        console.log('   BNB Approvals (pay-for-success):');
        if (bnbApprovalStatus) {
          const status = bnbApprovalStatus.usdt && bnbApprovalStatus.usdc ? '✅' : '⚠️';
          const tokens = [
            bnbApprovalStatus.usdt ? 'USDT✓' : 'USDT✗',
            bnbApprovalStatus.usdc ? 'USDC✓' : 'USDC✗',
          ].join(', ');
          console.log(`     BNB:          ${status} ${tokens}`);
        }
        if (bnbTestnetApprovalStatus) {
          const status = bnbTestnetApprovalStatus.usdt && bnbTestnetApprovalStatus.usdc ? '✅' : '⚠️';
          const tokens = [
            bnbTestnetApprovalStatus.usdt ? 'USDT✓' : 'USDT✗',
            bnbTestnetApprovalStatus.usdc ? 'USDC✓' : 'USDC✗',
          ].join(', ');
          console.log(`     BNB Testnet:  ${status} ${tokens}`);
        }
      }
      
      console.log('');
      console.log('   Spending Limits:');
      console.log(`     Per Transaction: $${config.limits.maxPerTx}`);
      console.log(`     Daily:           $${config.limits.maxPerDay}`);
      
      // Show Solana wallet status if it exists
      const solanaAddress = getSolanaAddress(options.configDir);
      if (solanaAddress) {
        console.log('');
        console.log('   ─────────────────────────────────');
        console.log(`   🟣 Solana: ${solanaAddress}`);
        
        try {
          // Get Solana devnet balances
          const devnetBalances = await getSolanaBalances(solanaAddress, 'solana_devnet');
          console.log(`     Devnet:    ${devnetBalances.sol.toFixed(4)} SOL | ${devnetBalances.usdc.toFixed(2)} USDC`);
        } catch (err: any) {
          console.log(`     Devnet:    (unable to fetch)`);
        }
        
        try {
          // Get Solana mainnet balances
          const mainnetBalances = await getSolanaBalances(solanaAddress, 'solana');
          console.log(`     Mainnet:   ${mainnetBalances.sol.toFixed(4)} SOL | ${mainnetBalances.usdc.toFixed(2)} USDC`);
        } catch (err: any) {
          console.log(`     Mainnet:   (unable to fetch)`);
        }
      }
      
      console.log('');
    }
  });

/**
 * npx moltspay list
 * 
 * List transactions for the agent wallet using Blockscout APIs (free, no API key needed)
 */
program
  .command('list')
  .description('List recent transactions')
  .option('--days <n>', 'Number of days to look back', '7')
  .option('--chain <chain>', 'Chain to query (base, polygon, base_sepolia, or all)', 'all')
  .option('--limit <n>', 'Max transactions to show', '20')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action(async (options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });

    if (!client.isInitialized) {
      console.log('❌ Not initialized. Run: npx moltspay init');
      return;
    }

    const days = parseInt(options.days) || 7;
    const limit = parseInt(options.limit) || 20;
    const chain = options.chain?.toLowerCase() || 'all';

    if (!['base', 'polygon', 'base_sepolia', 'tempo_moderato', 'all'].includes(chain)) {
      console.log('❌ Invalid chain. Use: base, polygon, base_sepolia, tempo_moderato, or all');
      return;
    }

    const wallet = client.address!;
    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);

    // Blockscout API configs (free, no API key needed)
    const explorers: Record<string, { api: string; usdc: string; name: string }> = {
      base: {
        api: 'https://base.blockscout.com/api/v2',
        usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        name: 'Base',
      },
      polygon: {
        api: 'https://polygon.blockscout.com/api/v2',
        usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        name: 'Polygon',
      },
      base_sepolia: {
        api: 'https://base-sepolia.blockscout.com/api/v2',
        usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        name: 'Base Sepolia',
      },
      // Tempo explorer doesn't have public API yet
      tempo_moderato: {
        api: '', // No API available
        usdc: '0x20c0000000000000000000000000000000000000',
        name: 'Tempo Moderato',
      },
    };

    const chainsToQuery = chain === 'all' ? ['base', 'polygon', 'base_sepolia', 'tempo_moderato'] : [chain];

    console.log(`\n📜 Transactions (last ${days} day${days > 1 ? 's' : ''})\n`);

    interface TokenTx {
      chain: string;
      timestamp: number;
      type: string;
      amount: number;
      other: string;
      hash: string;
      token?: string; // Token name (e.g., pathUSD, alphaUSD for Tempo)
    }

    let allTxns: TokenTx[] = [];

    for (const c of chainsToQuery) {
      const explorer = explorers[c];
      
      try {
        if (c === 'tempo_moderato') {
          // Tempo: use eth_getLogs RPC instead of Blockscout API
          const tempoTokens = [
            { address: '0x20c0000000000000000000000000000000000000', name: 'pathUSD' },
            { address: '0x20c0000000000000000000000000000000000001', name: 'alphaUSD' },
            { address: '0x20c0000000000000000000000000000000000002', name: 'betaUSD' },
            { address: '0x20c0000000000000000000000000000000000003', name: 'thetaUSD' },
          ];
          
          // Transfer event topic: keccak256("Transfer(address,address,uint256)")
          const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
          const walletTopic = '0x000000000000000000000000' + wallet.toLowerCase().slice(2);
          
          // Get latest block with retry
          let latestBlock = 0;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const blockRes = await fetch('https://rpc.moderato.tempo.xyz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
              });
              const blockData = await blockRes.json() as { result: string };
              if (blockData.result) {
                latestBlock = parseInt(blockData.result, 16);
                break;
              }
            } catch (e) {
              if (attempt === 2) throw e;
              await new Promise(r => setTimeout(r, 500)); // Wait 500ms before retry
            }
          }
          
          if (latestBlock === 0) {
            console.log('   ⚠️  Tempo Moderato: Could not get latest block');
            continue;
          }
          
          // Tempo RPC has 100000 block limit, so we can only query ~14 hours back
          // For longer ranges, we'd need multiple queries (not implemented yet)
          const maxBlocks = 100000;
          const blocksPerDay = 172800; // at ~0.5s/block
          const requestedBlocks = blocksPerDay * days;
          const actualBlocks = Math.min(requestedBlocks, maxBlocks);
          const fromBlock = '0x' + Math.max(0, latestBlock - actualBlocks).toString(16);
          const toBlock = '0x' + latestBlock.toString(16); // Use fixed block to avoid range drift
          
          // Note: Tempo RPC has 100k block limit (~14 hours at 0.5s/block)
          if (requestedBlocks > maxBlocks) {
            console.log(`   ℹ️  Tempo: querying last ~14 hours (RPC limit: 100k blocks)`);
          }
          
          for (const token of tempoTokens) {
            try {
              // Query incoming transfers (to = wallet)
              const inRes = await fetch('https://rpc.moderato.tempo.xyz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'eth_getLogs',
                  params: [{ fromBlock, toBlock, address: token.address, topics: [transferTopic, null, walletTopic] }],
                  id: 1,
                }),
              });
              const inData = await inRes.json() as { result?: Array<{ data: string; topics: string[]; transactionHash: string; blockTimestamp: string }>; error?: { message: string } };
              
              if (inData.error) {
                console.log(`   ⚠️  ${token.name}: ${inData.error.message}`);
                continue;
              }
              
              if (inData.result && Array.isArray(inData.result)) {
                for (const log of inData.result) {
                  const timestamp = parseInt(log.blockTimestamp, 16) * 1000;
                  if (timestamp < cutoffTime) continue;
                  const amount = parseInt(log.data, 16) / 1e6;
                  const from = '0x' + log.topics[1].slice(26);
                  allTxns.push({
                    chain: c,
                    timestamp,
                    type: 'IN',
                    amount,
                    other: from,
                    hash: log.transactionHash,
                    token: token.name,
                  });
                }
              }
              
              // Query outgoing transfers (from = wallet)
              const outRes = await fetch('https://rpc.moderato.tempo.xyz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'eth_getLogs',
                  params: [{ fromBlock, toBlock, address: token.address, topics: [transferTopic, walletTopic, null] }],
                  id: 1,
                }),
              });
              const outData = await outRes.json() as { result?: Array<{ data: string; topics: string[]; transactionHash: string; blockTimestamp: string }>; error?: { message: string } };
              
              if (outData.result && Array.isArray(outData.result)) {
                for (const log of outData.result) {
                  const timestamp = parseInt(log.blockTimestamp, 16) * 1000;
                  if (timestamp < cutoffTime) continue;
                  const amount = parseInt(log.data, 16) / 1e6;
                  const to = '0x' + log.topics[2].slice(26);
                  allTxns.push({
                    chain: c,
                    timestamp,
                    type: 'OUT',
                    amount,
                    other: to,
                    hash: log.transactionHash,
                    token: token.name,
                  });
                }
              }
            } catch (tokenError) {
              // Silently continue to next token if one fails
              continue;
            }
          }
        } else {
          // Other chains: use Blockscout API
          const url = `${explorer.api}/addresses/${wallet}/token-transfers?type=ERC-20&token=${explorer.usdc}`;
          const response = await fetch(url);
          const data = await response.json() as { 
            items: Array<{
              timestamp: string;
              from: { hash: string };
              to: { hash: string };
              total: { value: string; decimals: string };
              transaction_hash: string;
            }>;
          };

          if (data.items && Array.isArray(data.items)) {
            for (const tx of data.items) {
              const timestamp = new Date(tx.timestamp).getTime();
              if (timestamp < cutoffTime) continue;

              const isIncoming = tx.to.hash.toLowerCase() === wallet.toLowerCase();
              const decimals = parseInt(tx.total.decimals) || 6;
              allTxns.push({
                chain: c,
                timestamp,
                type: isIncoming ? 'IN' : 'OUT',
                amount: parseInt(tx.total.value) / Math.pow(10, decimals),
                other: isIncoming ? tx.from.hash : tx.to.hash,
                hash: tx.transaction_hash,
              });
            }
          }
        }
      } catch (error) {
        // Show error details for debugging
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ⚠️  ${explorer.name}: ${errMsg}`);
      }
    }

    // Sort by timestamp descending
    allTxns.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit
    allTxns = allTxns.slice(0, limit);

    if (allTxns.length === 0) {
      console.log('   (no transactions found)\n');
    } else {
      for (const tx of allTxns) {
        const sign = tx.type === 'IN' ? '+' : '-';
        const color = tx.type === 'IN' ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';
        const date = new Date(tx.timestamp).toISOString().slice(5, 16).replace('T', ' ');
        let chainLabel = tx.chain.toUpperCase();
        if (tx.chain === 'tempo_moderato') chainLabel = 'TEMPO';
        else if (tx.chain === 'base_sepolia') chainLabel = 'BASE_SEPOLIA';
        const chainTag = chain === 'all' ? `[${chainLabel}] ` : '';
        
        const tokenName = tx.token || 'USDC';
        console.log(`   ${color}${sign}${tx.amount.toFixed(2)} ${tokenName}${reset} | ${chainTag}${tx.type === 'IN' ? 'from' : 'to'} ${tx.other.slice(0, 10)}...${tx.other.slice(-4)} | ${date}`);
      }
      
      // Summary
      const inTotal = allTxns.filter(t => t.type === 'IN').reduce((s, t) => s + t.amount, 0);
      const outTotal = allTxns.filter(t => t.type === 'OUT').reduce((s, t) => s + t.amount, 0);
      console.log(`\n   📊 ${allTxns.length} transaction(s) | \x1b[32m+$${inTotal.toFixed(2)}\x1b[0m in | \x1b[31m-$${outTotal.toFixed(2)}\x1b[0m out\n`);
    }
  });

/**
 * npx moltspay services <url>
 */
program
  .command('services [url]')
  .description('List services from registry or a specific provider')
  .option('-q, --query <keyword>', 'Search by keyword (name, description, tags)')
  .option('--max-price <price>', 'Maximum price in USD')
  .option('--type <type>', 'Filter by type: api_service | file_download')
  .option('--tag <tag>', 'Filter by tag')
  .option('--json', 'Output as JSON')
  .action(async (url, options) => {
    const MOLTSPAY_REGISTRY = 'https://moltspay.com';
    
    try {
      let services: any;
      let isRegistry = false;
      
      if (url) {
        // Query specific provider
        const client = new MoltsPayClient();
        services = await client.getServices(url);
      } else {
        // Query MoltsPay registry with filters
        isRegistry = true;
        const params = new URLSearchParams();
        if (options.query) params.set('q', options.query);
        if (options.maxPrice) params.set('maxPrice', options.maxPrice);
        if (options.type) params.set('type', options.type);
        if (options.tag) params.set('tag', options.tag);
        
        const queryString = params.toString();
        const registryUrl = `${MOLTSPAY_REGISTRY}/registry/services${queryString ? '?' + queryString : ''}`;
        
        const res = await fetch(registryUrl);
        if (!res.ok) {
          throw new Error(`Registry request failed: ${res.status}`);
        }
        services = await res.json();
      }

      if (options.json) {
        console.log(JSON.stringify(services, null, 2));
      } else {
        const serviceList = services.services || [];
        
        if (isRegistry) {
          // Registry listing
          if (options.query) {
            console.log(`\n🔍 Search: "${options.query}" (${serviceList.length} results)\n`);
          } else {
            const filters = [];
            if (options.maxPrice) filters.push(`max $${options.maxPrice}`);
            if (options.type) filters.push(options.type);
            if (options.tag) filters.push(`#${options.tag}`);
            const filterStr = filters.length > 0 ? ` (${filters.join(', ')})` : '';
            console.log(`\n🔍 MoltsPay Registry${filterStr} - ${serviceList.length} services\n`);
          }
          
          // Table-like output for registry
          for (const svc of serviceList) {
            const name = (svc.name || svc.id).slice(0, 30).padEnd(30);
            const price = `$${svc.price}`.padEnd(8);
            const type = (svc.type || 'unknown').padEnd(14);
            const provider = `@${svc.provider?.username || 'unknown'}`;
            console.log(`   ${name} ${price} ${type} ${provider}`);
          }
          
          if (serviceList.length > 0) {
            console.log(`\n   💡 Use: moltspay pay <provider-url> <service-id>\n`);
          }
        } else {
          // Single provider format
          if (services.provider) {
            console.log(`\n🏪 ${services.provider.name}\n`);
            console.log(`   ${services.provider.description || ''}`);
            console.log(`   Wallet: ${services.provider.wallet}`);
            
            const chains = services.provider.chains 
              ? (Array.isArray(services.provider.chains) 
                  ? services.provider.chains.map((c: any) => typeof c === 'string' ? c : c.chain).join(', ')
                  : services.provider.chains)
              : services.provider.chain || 'base';
            console.log(`   Chains: ${chains}`);
          } else {
            console.log(`\n🏪 Provider Services\n`);
            console.log(`   ${serviceList.length} services available`);
          }
          
          console.log('\n📦 Services:\n');
          
          for (const svc of serviceList) {
            const status = svc.available !== false ? '✅' : '❌';
            console.log(`   ${status} ${svc.id || svc.name}`);
            console.log(`      ${svc.name} - $${svc.price} ${svc.currency}`);
            if (svc.description) {
              console.log(`      ${svc.description}`);
            }
            if (svc.provider && !services.provider) {
              console.log(`      Provider: ${svc.provider.name || svc.provider.username}`);
            }
            console.log('');
          }
        }
      }
    } catch (err: any) {
      console.error('❌ Error:', err.message);
    }
  });

/**
 * npx moltspay start <paths...>
 * 
 * Start server from skill directories or manifest files.
 * 
 * Supports:
 * - Skill directory: ./skills/video_gen/ (with moltspay.services.json + index.js)
 * - Legacy manifest: ./moltspay.services.json (with optional command field)
 * - Multiple paths: ./skills/video_gen/ ./skills/translation/
 * 
 * Services with "function" field load from skill's index.js
 * Services with "command" field execute shell commands (legacy)
 */
program
  .command('start <paths...>')
  .description('Start MoltsPay server from skill directories or manifest files')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--host <host>', 'Host to bind', '0.0.0.0')
  .option('--facilitator <url>', 'x402 facilitator URL (default: https://x402.org/facilitator)')
  .action(async (paths, options) => {
    const port = parseInt(options.port, 10);
    const host = options.host;
    const facilitatorUrl = options.facilitator;

    // Support comma-separated paths
    const allPaths = paths.flatMap((p: string) => p.split(',').map(s => s.trim())).filter(Boolean);

    console.log(`\n🚀 Starting MoltsPay Server (x402 protocol)\n`);

    // Collect all services and handlers from all paths
    const allServices: any[] = [];
    const handlers: Map<string, (params: any) => Promise<any>> = new Map();
    let provider: any = null;

    for (const inputPath of allPaths) {
      const resolvedPath = resolve(inputPath);
      
      // Determine if it's a directory (skill) or file (manifest)
      let manifestPath: string;
      let skillDir: string;
      let isSkillDir = false;

      if (existsSync(join(resolvedPath, 'moltspay.services.json'))) {
        // It's a skill directory
        manifestPath = join(resolvedPath, 'moltspay.services.json');
        skillDir = resolvedPath;
        isSkillDir = true;
      } else if (existsSync(resolvedPath) && resolvedPath.endsWith('.json')) {
        // It's a manifest file
        manifestPath = resolvedPath;
        skillDir = dirname(resolvedPath);
      } else if (existsSync(resolvedPath)) {
        // Directory without moltspay.services.json
        console.error(`❌ No moltspay.services.json found in: ${resolvedPath}`);
        continue;
      } else {
        console.error(`❌ Path not found: ${resolvedPath}`);
        continue;
      }

      console.log(`📦 Loading: ${manifestPath}`);

      try {
        const manifestContent = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        
        // Use first provider found, or merge
        if (!provider) {
          provider = manifestContent.provider;
        }

        // Load skill module if it's a skill directory
        let skillModule: any = null;
        if (isSkillDir) {
          // Determine entry point: check package.json main, fallback to index.js
          let entryPoint = 'index.js';
          const pkgJsonPath = join(skillDir, 'package.json');
          if (existsSync(pkgJsonPath)) {
            try {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
              if (pkgJson.main) {
                entryPoint = pkgJson.main;
              }
            } catch {
              // Ignore package.json parse errors
            }
          }

          const modulePath = join(skillDir, entryPoint);
          if (existsSync(modulePath)) {
            try {
              skillModule = await import(modulePath);
              console.log(`   ✅ Loaded module: ${modulePath}`);
            } catch (err: any) {
              console.error(`   ⚠️  Failed to load module: ${err.message}`);
            }
          } else {
            console.error(`   ⚠️  Entry point not found: ${modulePath}`);
          }
        }

        // Register each service
        for (const service of manifestContent.services) {
          allServices.push(service);

          // Priority: function > command
          if (service.function && skillModule) {
            // New skill-based approach: import function from index.js
            const fn = skillModule[service.function] || skillModule.default?.[service.function];
            if (fn && typeof fn === 'function') {
              handlers.set(service.id, fn);
              console.log(`   ✅ ${service.id} → ${service.function}()`);
            } else {
              console.error(`   ❌ Function '${service.function}' not found in index.js`);
            }
          } else if (service.command) {
            // Legacy command-based approach
            const workdir = skillDir;
            handlers.set(service.id, async (params) => {
              return new Promise((resolvePromise, reject) => {
                const proc = spawn('sh', ['-c', service.command], {
                  cwd: workdir,
                  stdio: ['pipe', 'pipe', 'pipe'],
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (data) => {
                  stdout += data.toString();
                });

                proc.stderr.on('data', (data) => {
                  stderr += data.toString();
                  process.stderr.write(data);
                });

                proc.stdin.write(JSON.stringify(params));
                proc.stdin.end();

                proc.on('close', (code) => {
                  if (code !== 0) {
                    reject(new Error(`Command failed (exit ${code}): ${stderr || 'Unknown error'}`));
                    return;
                  }
                  try {
                    resolvePromise(JSON.parse(stdout.trim()));
                  } catch {
                    resolvePromise({ output: stdout.trim() });
                  }
                });

                proc.on('error', (err) => {
                  reject(new Error(`Failed to spawn command: ${err.message}`));
                });
              });
            });
            console.log(`   ✅ ${service.id} → command`);
          } else {
            console.warn(`   ⚠️  ${service.id}: no function or command defined`);
          }
        }
      } catch (err: any) {
        console.error(`❌ Failed to load ${manifestPath}: ${err.message}`);
        continue;
      }
    }

    if (allServices.length === 0) {
      console.error('\n❌ No services loaded. Exiting.');
      process.exit(1);
    }

    if (!provider) {
      console.error('\n❌ No provider config found. Exiting.');
      process.exit(1);
    }

    // Create combined manifest for server
    const combinedManifest = {
      provider,
      services: allServices,
    };

    // Write temporary manifest for server
    const tempManifestPath = join(DEFAULT_CONFIG_DIR, 'combined-manifest.json');
    writeFileSync(tempManifestPath, JSON.stringify(combinedManifest, null, 2));

    console.log(`\n📋 Combined manifest: ${allServices.length} services`);
    console.log(`   Provider: ${provider.name}`);
    console.log(`   Wallet: ${provider.wallet}`);
    console.log(`   Port: ${port}`);
    console.log('');

    try {
      const server = new MoltsPayServer(tempManifestPath, { port, host, facilitatorUrl });

      // Register all handlers
      for (const [serviceId, handler] of handlers) {
        server.skill(serviceId, handler);
      }

      // Write PID file
      const pidData = { pid: process.pid, port, paths: allPaths };
      writeFileSync(PID_FILE, JSON.stringify(pidData, null, 2));

      // Start listening
      server.listen(port);

      // Cleanup function
      const cleanup = () => {
        try {
          if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
          if (existsSync(tempManifestPath)) unlinkSync(tempManifestPath);
        } catch {}
      };

      process.on('SIGINT', () => {
        console.log('\n\n👋 Shutting down...');
        cleanup();
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        console.log('\n\n👋 Shutting down...');
        cleanup();
        process.exit(0);
      });

      process.on('exit', cleanup);

    } catch (err: any) {
      console.error(`❌ Failed to start server: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * npx moltspay stop
 * 
 * Stop the running MoltsPay server gracefully
 */
program
  .command('stop')
  .description('Stop the running MoltsPay server')
  .action(async () => {
    if (!existsSync(PID_FILE)) {
      console.log('❌ No running server found (no PID file)');
      process.exit(1);
    }

    try {
      const pidData = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      const { pid, port, manifest } = pidData;

      console.log(`\n🛑 Stopping MoltsPay Server\n`);
      console.log(`   PID: ${pid}`);
      console.log(`   Port: ${port}`);
      console.log(`   Manifest: ${manifest}`);
      console.log('');

      // Check if process is running
      try {
        process.kill(pid, 0); // Test if process exists
      } catch {
        console.log('⚠️  Process not running, cleaning up PID file...');
        unlinkSync(PID_FILE);
        process.exit(0);
      }

      // Send SIGTERM for graceful shutdown
      process.kill(pid, 'SIGTERM');
      console.log('✅ Sent SIGTERM to server');

      // Wait a bit and check if it stopped
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        process.kill(pid, 0);
        console.log('⚠️  Server still running, sending SIGKILL...');
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process is gone, good
      }

      // Clean up PID file if still exists
      if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
      }

      console.log('✅ Server stopped\n');

    } catch (err: any) {
      console.error(`❌ Failed to stop server: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * npx moltspay pay <server> <service> <params>
 * 
 * Pay for a service and get the result
 * 
 * --image can be a URL or local file path:
 *   URL: https://example.com/image.jpg -> sends as image_url
 *   File: ./image.jpg or /path/to/image.jpg -> sends as image_base64
 * 
 * --token specifies which stablecoin to use (USDC or USDT)
 * --chain specifies which chain to pay on (base or polygon, default: base)
 */
program
  .command('pay <server> <service> [params]')
  .description('Pay for a service and get the result')
  .option('--prompt <text>', 'Prompt for the service')
  .option('--image <path>', 'Image URL or local file path')
  .option('--token <token>', 'Token to pay with (USDC or USDT)', 'USDC')
  .option('--chain <chain>', 'Chain to pay on (base, polygon, base_sepolia, tempo_moderato, solana, or solana_devnet).')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, service, paramsJson, options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });

    if (!client.isInitialized) {
      console.error('❌ Wallet not initialized. Run: npx moltspay init');
      process.exit(1);
    }

    // Build params from JSON string or options
    let params: Record<string, any> = {};
    
    if (paramsJson) {
      try {
        params = JSON.parse(paramsJson);
      } catch {
        console.error('❌ Invalid JSON params');
        process.exit(1);
      }
    }
    
    // Override with CLI options
    if (options.prompt) params.prompt = options.prompt;
    
    // Handle --image: URL or local file
    if (options.image) {
      const imagePath = options.image;
      
      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        // It's a URL
        params.image_url = imagePath;
      } else {
        // It's a local file - read and convert to base64
        const filePath = resolve(imagePath);
        
        if (!existsSync(filePath)) {
          console.error(`❌ Image file not found: ${filePath}`);
          process.exit(1);
        }
        
        const imageData = readFileSync(filePath);
        params.image_base64 = imageData.toString('base64');
      }
    }

    // Validate chain option (if specified)
    const supportedPayChains = ['base', 'polygon', 'base_sepolia', 'tempo_moderato', 'bnb', 'bnb_testnet', 'solana', 'solana_devnet'];
    const chain = options.chain?.toLowerCase();
    if (chain && !supportedPayChains.includes(chain)) {
      console.error(`❌ Unknown chain: ${chain}. Supported: ${supportedPayChains.join(', ')}`);
      process.exit(1);
    }

    const imageDisplay = params.image_url || (params.image_base64 ? `[local file: ${options.image}]` : null);
    const token = (options.token || 'USDC').toUpperCase();

    // USDT requires gas - check native balance
    if (token === 'USDT') {
      const balance = await client.getBalance();
      if (balance.native < 0.0001) {
        console.log('\n⚠️  USDT requires a small amount of ETH for gas (~$0.01)');
        console.log(`   Your ETH balance: ${balance.native.toFixed(6)} ETH`);
        console.log('   Please add a tiny amount of ETH to your wallet.\n');
        process.exit(1);
      }
      if (!options.json) {
        console.log('\n⚠️  Note: USDT payments require gas (~$0.01 on Base)');
      }
    }

    if (!options.json) {
      console.log(`\n💳 MoltsPay - Paying for service\n`);
      console.log(`   Server: ${server}`);
      console.log(`   Service: ${service}`);
      console.log(`   Prompt: ${params.prompt}`);
      if (imageDisplay) console.log(`   Image: ${imageDisplay}`);
      console.log(`   Chain: ${chain || '(auto)'}`);  // Will be determined by server
      console.log(`   Token: ${token}`);
      console.log(`   Wallet: ${client.address}`);
      console.log('');
    }

    try {
      // All chains use the same pay() flow - protocol detection happens inside
      // Server's /proxy endpoint handles both x402 and MPP based on chain
      const result = await client.pay(server, service, params, { 
        token: token as 'USDC' | 'USDT',
        chain
      });
      
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log('✅ Success!\n');
        console.log(JSON.stringify(result, null, 2));
        console.log('');
      }
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({ error: err.message }));
      } else {
        console.error(`❌ Error: ${err.message}`);
      }
      process.exit(1);
    }
  });

/**
 * npx moltspay validate <path>
 */
program
  .command('validate <path>')
  .description('Validate a moltspay.services.json file against the schema')
  .action(async (inputPath) => {
    const resolvedPath = resolve(inputPath);
    
    // Find manifest file
    let manifestPath: string;
    if (existsSync(join(resolvedPath, 'moltspay.services.json'))) {
      manifestPath = join(resolvedPath, 'moltspay.services.json');
    } else if (resolvedPath.endsWith('.json') && existsSync(resolvedPath)) {
      manifestPath = resolvedPath;
    } else {
      console.error(`❌ Not found: ${resolvedPath}`);
      process.exit(1);
    }

    console.log(`\n📋 Validating: ${manifestPath}\n`);

    try {
      const content = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const errors: string[] = [];

      // Validate provider
      if (!content.provider) {
        errors.push('Missing required field: provider');
      } else {
        if (!content.provider.name) errors.push('Missing provider.name');
        if (!content.provider.wallet) errors.push('Missing provider.wallet');
        else if (!/^0x[a-fA-F0-9]{40}$/.test(content.provider.wallet)) {
          errors.push('Invalid provider.wallet (must be Ethereum address)');
        }
      }

      // Validate services
      if (!content.services || !Array.isArray(content.services)) {
        errors.push('Missing required field: services (array)');
      } else if (content.services.length === 0) {
        errors.push('services array must have at least one service');
      } else {
        content.services.forEach((svc: any, i: number) => {
          const prefix = `services[${i}]`;
          if (!svc.id) errors.push(`${prefix}: missing id`);
          else if (!/^[a-z0-9-]+$/.test(svc.id)) {
            errors.push(`${prefix}: id must be lowercase with hyphens only`);
          }
          if (typeof svc.price !== 'number') errors.push(`${prefix}: missing or invalid price`);
          if (!svc.currency) errors.push(`${prefix}: missing currency`);
          if (!svc.function && !svc.command) {
            errors.push(`${prefix}: must have either "function" or "command"`);
          }
        });
      }

      if (errors.length > 0) {
        console.log('❌ Validation failed:\n');
        errors.forEach(e => console.log(`   • ${e}`));
        console.log('');
        process.exit(1);
      }

      console.log('✅ Valid!\n');
      console.log(`   Provider: ${content.provider.name}`);
      console.log(`   Wallet: ${content.provider.wallet}`);
      console.log(`   Services: ${content.services.length}`);
      content.services.forEach((svc: any) => {
        console.log(`     - ${svc.id} ($${svc.price} ${svc.currency})`);
      });
      console.log('');

    } catch (err: any) {
      console.error(`❌ Parse error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
