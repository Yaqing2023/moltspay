#!/usr/bin/env node
/**
 * Payment Agent CLI
 */

import { Command } from 'commander';
import { PaymentAgent, Wallet, SecureWallet, CHAINS, listChains } from '../src/index.js';

const program = new Command();

program
  .name('payment-agent')
  .description('Blockchain payment infrastructure for AI Agents')
  .version('0.1.0');

// ============ balance ============
program
  .command('balance')
  .description('Get wallet balance')
  .option('-c, --chain <chain>', 'Chain name', 'base_sepolia')
  .option('-a, --address <address>', 'Wallet address')
  .action(async (options) => {
    try {
      const agent = new PaymentAgent({
        chain: options.chain,
        walletAddress: options.address || process.env.PAYMENT_AGENT_WALLET,
      });
      
      const balance = await agent.getBalance();
      console.log(JSON.stringify(balance, null, 2));
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

// ============ invoice ============
program
  .command('invoice')
  .description('Generate payment invoice')
  .requiredOption('-o, --order <orderId>', 'Order ID')
  .requiredOption('-a, --amount <amount>', 'Amount in USDC')
  .option('-s, --service <service>', 'Service type', 'payment')
  .option('-c, --chain <chain>', 'Chain name', 'base_sepolia')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    try {
      const agent = new PaymentAgent({
        chain: options.chain,
        walletAddress: process.env.PAYMENT_AGENT_WALLET,
      });
      
      const invoice = agent.createInvoice({
        orderId: options.order,
        amount: parseFloat(options.amount),
        service: options.service,
      });

      if (options.json) {
        console.log(JSON.stringify(invoice, null, 2));
      } else {
        console.log(agent.formatInvoiceMessage(invoice));
      }
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

// ============ verify ============
program
  .command('verify')
  .description('Verify a payment transaction')
  .requiredOption('-t, --tx <txHash>', 'Transaction hash')
  .option('-a, --amount <amount>', 'Expected amount')
  .option('-c, --chain <chain>', 'Chain name', 'base_sepolia')
  .action(async (options) => {
    try {
      const agent = new PaymentAgent({
        chain: options.chain,
        walletAddress: process.env.PAYMENT_AGENT_WALLET,
      });
      
      const result = await agent.verifyPayment(options.tx, {
        expectedAmount: options.amount ? parseFloat(options.amount) : undefined,
      });

      console.log(JSON.stringify(result, null, 2));
      process.exit(result.verified ? 0 : 1);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

// ============ transfer ============
program
  .command('transfer')
  .description('Transfer USDC (requires private key)')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('-a, --amount <amount>', 'Amount in USDC')
  .option('-r, --reason <reason>', 'Transfer reason')
  .option('-c, --chain <chain>', 'Chain name', 'base_sepolia')
  .option('--secure', 'Use secure wallet with limits')
  .action(async (options) => {
    try {
      if (options.secure) {
        const wallet = new SecureWallet({ chain: options.chain });
        const result = await wallet.transfer({
          to: options.to,
          amount: parseFloat(options.amount),
          reason: options.reason,
        });
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      } else {
        const wallet = new Wallet({ chain: options.chain });
        const result = await wallet.transfer(options.to, parseFloat(options.amount));
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      }
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

// ============ chains ============
program
  .command('chains')
  .description('List supported chains')
  .action(() => {
    const chains = listChains();
    console.log('Supported chains:');
    for (const name of chains) {
      const config = CHAINS[name];
      console.log(`  ${name}: ${config.name} (chainId: ${config.chainId})`);
    }
  });

// ============ init ============
program
  .command('init')
  .description('Initialize agent wallet')
  .option('-c, --chain <chain>', 'Chain name', 'base')
  .option('-d, --dir <directory>', 'Storage directory', '~/.moltspay')
  .option('--cdp', 'Use CDP (Coinbase Developer Platform) wallet')
  .option('--local', 'Use local wallet (default)')
  .action(async (options) => {
    const storageDir = options.dir.replace('~', process.env.HOME || '.');
    
    if (options.cdp) {
      // CDP wallet
      const { initCDPWallet } = await import('./cdp/index.js');
      
      console.log('🔄 Initializing CDP wallet...');
      const result = await initCDPWallet({
        chain: options.chain,
        storageDir,
      });
      
      if (!result.success) {
        console.error('❌ Failed:', result.error);
        console.log('');
        console.log('To use CDP wallet, set these environment variables:');
        console.log('  export CDP_API_KEY_ID=your-key-id');
        console.log('  export CDP_API_KEY_SECRET=your-key-secret');
        console.log('  export CDP_WALLET_SECRET=your-wallet-secret  # optional');
        console.log('');
        console.log('Get credentials at: https://cdp.coinbase.com/');
        process.exit(1);
      }
      
      console.log('✅ CDP wallet initialized');
      console.log(`   Address: ${result.address}`);
      console.log(`   Chain: ${options.chain}`);
      console.log(`   Storage: ${result.storagePath}`);
      console.log(`   New wallet: ${result.isNew ? 'Yes' : 'No (loaded existing)'}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  1. Fund your wallet: Send USDC to ${result.address}`);
      console.log('  2. Use x402 to pay for services automatically');
      console.log('');
      console.log('Example:');
      console.log('  import { createX402Client } from "moltspay/x402";');
      console.log('  const client = await createX402Client({ chain: "base", useCDP: true });');
      console.log('  const response = await client.fetch("https://api.example.com/paid-resource");');
    } else {
      // Local wallet (default)
      const { AgentWallet } = await import('./agent/AgentWallet.js');
      
      const wallet = new AgentWallet({
        chain: options.chain,
        storageDir,
      });
      
      console.log('✅ Local wallet initialized');
      console.log(`   Address: ${wallet.address}`);
      console.log(`   Chain: ${options.chain}`);
      console.log(`   Storage: ${storageDir}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  1. Fund your wallet: Send USDC to ${wallet.address}`);
      console.log(`  2. Send a small amount of ETH for gas (~0.001 ETH)`);
      console.log('');
      console.log('Or use Permit (no gas needed):');
      console.log(`  npx moltspay auth-request --owner <OWNER_ADDRESS> --amount <USDC_AMOUNT>`);
    }
  });

// ============ auth-request ============
program
  .command('auth-request')
  .description('Generate authorization request for Owner')
  .requiredOption('-o, --owner <address>', 'Owner wallet address (e.g., MetaMask)')
  .requiredOption('-a, --amount <amount>', 'Amount in USDC to authorize')
  .option('-c, --chain <chain>', 'Chain name', 'base')
  .option('-e, --expires <hours>', 'Expiration in hours', '168')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { AgentWallet } = await import('./agent/AgentWallet.js');
    
    const wallet = new AgentWallet({ chain: options.chain });
    const request = await wallet.generateAuthRequest({
      ownerAddress: options.owner,
      amount: parseFloat(options.amount),
      expiresInHours: parseInt(options.expires),
    });
    
    if (options.json) {
      console.log(JSON.stringify({
        agentAddress: wallet.address,
        typedData: request.typedData,
        cliCommand: request.cliCommand,
      }, null, 2));
    } else {
      console.log(request.message);
    }
  });

// ============ sign-permit ============
program
  .command('sign-permit')
  .description('Sign a permit (Owner uses this to authorize Agent)')
  .requiredOption('-o, --owner <address>', 'Owner address')
  .requiredOption('-s, --spender <address>', 'Spender address (Agent)')
  .requiredOption('-a, --amount <amount>', 'Amount in USDC')
  .requiredOption('-d, --deadline <timestamp>', 'Deadline timestamp')
  .requiredOption('-n, --nonce <nonce>', 'Nonce from contract')
  .option('-c, --chain <chain>', 'Chain name', 'base')
  .option('-k, --private-key <key>', 'Private key (or set OWNER_PRIVATE_KEY env)')
  .action(async (options) => {
    const { ethers } = await import('ethers');
    const { getChain } = await import('./chains/index.js');
    
    const privateKey = options.privateKey || process.env.OWNER_PRIVATE_KEY;
    if (!privateKey) {
      console.error('Error: Private key required. Use --private-key or set OWNER_PRIVATE_KEY env');
      process.exit(1);
    }
    
    const chainConfig = getChain(options.chain);
    const wallet = new ethers.Wallet(privateKey);
    
    if (wallet.address.toLowerCase() !== options.owner.toLowerCase()) {
      console.error(`Error: Private key doesn't match owner address`);
      console.error(`  Expected: ${options.owner}`);
      console.error(`  Got: ${wallet.address}`);
      process.exit(1);
    }
    
    const value = BigInt(Math.floor(parseFloat(options.amount) * 1e6)).toString();
    
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: chainConfig.chainId,
      verifyingContract: chainConfig.usdc,
    };
    
    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    
    const message = {
      owner: options.owner,
      spender: options.spender,
      value,
      nonce: parseInt(options.nonce),
      deadline: parseInt(options.deadline),
    };
    
    const signature = await wallet.signTypedData(domain, types, message);
    const sig = ethers.Signature.from(signature);
    
    const permit = {
      owner: options.owner,
      value,
      deadline: parseInt(options.deadline),
      nonce: parseInt(options.nonce),
      v: sig.v,
      r: sig.r,
      s: sig.s,
    };
    
    console.log('✅ Permit signed successfully!');
    console.log('');
    console.log('Send this to your Agent:');
    console.log(JSON.stringify(permit, null, 2));
  });

// ============ spend ============
program
  .command('spend')
  .description('Spend USDC from Owner wallet (requires permit)')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('-a, --amount <amount>', 'Amount in USDC')
  .option('-c, --chain <chain>', 'Chain name', 'base')
  .option('-p, --permit <json>', 'Permit JSON (or stored permit is used)')
  .action(async (options) => {
    const { AgentWallet } = await import('./agent/AgentWallet.js');
    
    const wallet = new AgentWallet({ chain: options.chain });
    
    let permit;
    if (options.permit) {
      permit = JSON.parse(options.permit);
    }
    
    console.log(`Spending ${options.amount} USDC to ${options.to}...`);
    const result = await wallet.spend(options.to, parseFloat(options.amount), permit);
    
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  });

// ============ x402 ============
program
  .command('x402')
  .description('Make HTTP request with automatic x402 payment')
  .argument('<url>', 'URL to request')
  .option('-X, --method <method>', 'HTTP method', 'GET')
  .option('-d, --data <json>', 'Request body (JSON)')
  .option('-H, --header <header...>', 'Additional headers (key:value)')
  .option('-c, --chain <chain>', 'Chain name', 'base')
  .option('--cdp', 'Use CDP wallet')
  .option('-o, --output <file>', 'Save response to file')
  .option('-v, --verbose', 'Show payment details')
  .action(async (url, options) => {
    const { createX402Client, isX402Available } = await import('./x402/client.js');
    
    // Check if x402 packages are available
    if (!isX402Available()) {
      console.error('❌ x402 packages not installed.');
      console.error('');
      console.error('Install them with:');
      console.error('  npm install @x402/fetch @x402/evm viem');
      process.exit(1);
    }
    
    try {
      // Create x402 client
      if (options.verbose) {
        console.error(`🔄 Initializing x402 client (chain: ${options.chain})...`);
      }
      
      const client = await createX402Client({
        chain: options.chain,
        useCDP: options.cdp,
      });
      
      if (options.verbose) {
        console.error(`   Wallet: ${client.address}`);
        console.error(`   Chain: ${client.chain}`);
        console.error('');
      }
      
      // Build request
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      if (options.header) {
        for (const h of options.header) {
          const [key, ...valueParts] = h.split(':');
          headers[key.trim()] = valueParts.join(':').trim();
        }
      }
      
      const init: RequestInit = {
        method: options.method.toUpperCase(),
        headers,
      };
      
      if (options.data && ['POST', 'PUT', 'PATCH'].includes(init.method as string)) {
        init.body = options.data;
      }
      
      if (options.verbose) {
        console.error(`📤 ${init.method} ${url}`);
        if (options.data) {
          console.error(`   Body: ${options.data.substring(0, 100)}${options.data.length > 100 ? '...' : ''}`);
        }
        console.error('');
      }
      
      // Make request with automatic payment
      const response = await client.fetch(url, init);
      
      if (options.verbose) {
        console.error(`📥 Response: ${response.status} ${response.statusText}`);
        console.error('');
      }
      
      // Handle response
      const contentType = response.headers.get('content-type') || '';
      let body: string;
      
      if (contentType.includes('application/json')) {
        const json = await response.json();
        body = JSON.stringify(json, null, 2);
      } else {
        body = await response.text();
      }
      
      // Output
      if (options.output) {
        const fs = await import('fs');
        fs.writeFileSync(options.output, body);
        console.error(`✅ Saved to ${options.output}`);
      } else {
        console.log(body);
      }
      
      process.exit(response.ok ? 0 : 1);
      
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      process.exit(1);
    }
  });

// ============ status ============
program
  .command('status')
  .description('Show agent wallet status')
  .option('-c, --chain <chain>', 'Chain name', 'base')
  .option('-o, --owner <address>', 'Check allowance from specific owner')
  .action(async (options) => {
    const { AgentWallet } = await import('./agent/AgentWallet.js');
    
    const wallet = new AgentWallet({ chain: options.chain });
    
    console.log('Agent Wallet Status');
    console.log('==================');
    console.log(`Address: ${wallet.address}`);
    console.log(`Chain: ${options.chain}`);
    console.log(`Gas balance: ${await wallet.getGasBalance()} ETH`);
    console.log(`Has gas: ${await wallet.hasGas() ? 'Yes ✅' : 'No ❌ (need ~0.0005 ETH)'}`);
    
    if (options.owner) {
      const allowance = await wallet.checkAllowance(options.owner);
      console.log('');
      console.log(`Allowance from ${options.owner}:`);
      console.log(`  Allowance: ${allowance.allowance} USDC`);
      console.log(`  Owner balance: ${allowance.ownerBalance} USDC`);
      console.log(`  Can spend: ${allowance.canSpend ? 'Yes ✅' : 'No ❌'}`);
    }
  });

program.parse();
