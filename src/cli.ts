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

program.parse();
