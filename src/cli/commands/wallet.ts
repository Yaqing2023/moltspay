import { Command } from 'commander';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { ethers } from 'ethers';
import { MoltsPayClient } from '../../client/index.js';
import { MoltsPayServer } from '../../server/index.js';
import { filterEnv as filterAlipayEnv } from '../../client/alipay/cli.js';
import { printQRCode, writeQRCodePng } from '../../onramp/index.js';
import { CHAINS } from '../../chains/index.js';
import { SOLANA_CHAINS, getSolanaExplorerUrl, getSolanaTxExplorerUrl, isSolanaChain } from '../../chains/solana.js';
import { 
  loadSolanaWallet, 
  createSolanaWallet, 
  getSolanaAddress, 
  getSolanaBalances,
  solanaWalletExists,
  isValidSolanaAddress,
} from '../../wallet/solana.js';
import type { ChainName, EvmChainName, TokenSymbol } from '../../types/index.js';
import { Wallet } from '../../wallet/Wallet.js';
import * as readline from 'readline';
import { DEFAULT_CONFIG_DIR, PID_FILE, GAS_SYMBOL, prompt, setupBNBApprovals, checkBNBApprovals, BNB_SPONSOR_KEY, BNB_SPENDER_ADDRESS, ERC20_APPROVE_ABI } from '../shared.js';

export function registerWallet(program: Command): void {
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
  .option('--chain <chain>', 'Chain to fund (base, polygon, solana, base_sepolia, bnb, or bnb_testnet)', 'base')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action(async (amountStr, options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount < 5) {
      console.log('❌ Minimum $5.');
      return;
    }

    const chain = (options.chain?.toLowerCase() || 'base') as 'base' | 'polygon' | 'base_sepolia' | 'solana' | 'bnb' | 'bnb_testnet';
    if (!['base', 'polygon', 'base_sepolia', 'solana', 'bnb', 'bnb_testnet'].includes(chain)) {
      console.log('❌ Invalid chain. Use: base, polygon, solana, base_sepolia, bnb, or bnb_testnet');
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
    
    // BNB Testnet: use faucet (gives USDC + tBNB for gas)
    if (chain === 'bnb_testnet') {
      console.log('\n🧪 BNB Testnet Funding\n');
      console.log(`   Wallet: ${walletAddress}`);
      console.log(`   Chain: BNB Testnet\n`);
      console.log('💡 Use the MoltsPay faucet to get testnet USDC + tBNB:\n');
      console.log('   npx moltspay faucet --chain bnb_testnet\n');
      console.log('   This gives you:\n');
      console.log('   • 1 USDC (testnet) for payments');
      console.log('   • 0.001 tBNB for gas (first approval tx)\n');
      return;
    }
    
    // BNB Mainnet: manual funding required (no Coinbase onramp)
    if (chain === 'bnb') {
      console.log('\n📋 BNB Chain Funding\n');
      console.log(`   Wallet: ${walletAddress}\n`);
      console.log('   To use MoltsPay on BNB Chain, you need:\n');
      console.log('   1. USDC for payments');
      console.log('      → Withdraw from Binance/exchange to your wallet address\n');
      console.log('   2. Small amount of BNB for gas (~0.001 BNB / ~$0.60)');
      console.log('      → First approval transaction requires gas');
      console.log('      → After approval, all payments are gasless\n');
      console.log('   💡 Tip: Most exchanges include BNB dust when you withdraw to BNB Chain\n');
      console.log('   ─────────────────────────────────────────────────────────────');
      console.log('   After funding, check status: npx moltspay status\n');
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
    
    // Save approved spender to wallet config for status command
    const walletPath = join(options.configDir || DEFAULT_CONFIG_DIR, 'wallet.json');
    try {
      const walletData = JSON.parse(readFileSync(walletPath, 'utf-8'));
      walletData.approvals = walletData.approvals || {};
      walletData.approvals[chain] = options.spender;
      writeFileSync(walletPath, JSON.stringify(walletData, null, 2));
      console.log(`✅ Approval complete! Spender saved for ${chain}.\n`);
    } catch (err) {
      console.log('✅ Approval complete!\n');
      console.log('⚠️  Could not save spender to wallet config');
    }
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
          // BNB chains: show balance + native BNB for gas
          const bnbBalance = balance.native;
          const bnbWarning = bnbBalance < 0.0005 ? ' ⚠️ Low gas' : '';
          console.log(`     ${chainLabel.padEnd(14)} ${balance.usdc.toFixed(2)} USDC | ${balance.usdt.toFixed(2)} USDT | ${bnbBalance.toFixed(4)} BNB${bnbWarning}`);
        } else {
          // EVM chains: show USDC/USDT
          console.log(`     ${chainLabel.padEnd(14)} ${balance.usdc.toFixed(2)} USDC | ${balance.usdt.toFixed(2)} USDT`);
        }
      }
      
      // Check BNB approval status
      const address = client.address!;
      let bnbApprovalStatus: { usdt: boolean; usdc: boolean; spender: string | null } | null = null;
      let bnbTestnetApprovalStatus: { usdt: boolean; usdc: boolean; spender: string | null } | null = null;
      
      try {
        if (allBalances['bnb']) {
          bnbApprovalStatus = await checkBNBApprovals(address, 'bnb', options.configDir);
        }
        if (allBalances['bnb_testnet']) {
          bnbTestnetApprovalStatus = await checkBNBApprovals(address, 'bnb_testnet', options.configDir);
        }
      } catch { /* ignore approval check errors */ }
      
      if (bnbApprovalStatus || bnbTestnetApprovalStatus) {
        console.log('');
        console.log('   BNB Approvals (pay-for-success):');
        if (bnbApprovalStatus) {
          if (!bnbApprovalStatus.spender) {
            console.log('     BNB:          ⚠️ No spender configured');
            console.log('     └─ Run a payment first, or: npx moltspay approve --chain bnb --spender <address>');
          } else {
            const status = bnbApprovalStatus.usdt && bnbApprovalStatus.usdc ? '✅' : '⚠️';
            const tokens = [
              bnbApprovalStatus.usdt ? 'USDT✓' : 'USDT✗',
              bnbApprovalStatus.usdc ? 'USDC✓' : 'USDC✗',
            ].join(', ');
            console.log(`     BNB:          ${status} ${tokens}`);
            
            // Show warning if no approval and low BNB
            const bnbNative = allBalances['bnb']?.native || 0;
            if (!bnbApprovalStatus.usdc && !bnbApprovalStatus.usdt && bnbNative < 0.0005) {
              console.log('     ⚠️  Need ~0.001 BNB for first approval tx. Get from exchange.');
            }
          }
        }
        if (bnbTestnetApprovalStatus) {
          if (!bnbTestnetApprovalStatus.spender) {
            console.log('     BNB Testnet:  ⚠️ No spender configured');
            console.log('     └─ Run a payment first, or: npx moltspay approve --chain bnb_testnet --spender <address>');
          } else {
            const status = bnbTestnetApprovalStatus.usdt && bnbTestnetApprovalStatus.usdc ? '✅' : '⚠️';
            const tokens = [
              bnbTestnetApprovalStatus.usdt ? 'USDT✓' : 'USDT✗',
              bnbTestnetApprovalStatus.usdc ? 'USDC✓' : 'USDC✗',
            ].join(', ');
            console.log(`     BNB Testnet:  ${status} ${tokens}`);
            
            // Show warning if no approval and low tBNB
            const tbnbNative = allBalances['bnb_testnet']?.native || 0;
            if (!bnbTestnetApprovalStatus.usdc && !bnbTestnetApprovalStatus.usdt && tbnbNative < 0.0005) {
              console.log('     ⚠️  Need tBNB for approval. Run: npx moltspay faucet --chain bnb_testnet');
            }
          }
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
}
