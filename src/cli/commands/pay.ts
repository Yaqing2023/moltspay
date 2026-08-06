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

export function registerPay(program: Command): void {
program
  .command('pay <server> <service> [params]')
  .description('Pay for a service and get the result')
  .option('--prompt <text>', 'Prompt for the service')
  .option('--image <path>', 'Image URL or local file path')
  .option('--data <json>', 'Raw JSON data to send (for custom input formats)')
  .option('--token <token>', 'Token to pay with (USDC or USDT)', 'USDC')
  .option('--chain <chain>', 'Chain to pay on (base, polygon, base_sepolia, tempo_moderato, solana, or solana_devnet).')
  .option('--rail <rail>', 'Payment rail: a chain name, "alipay" (CNY via alipay-bot), "wechat" (CNY via WeChat Native, scan to pay), or "balance" (password-free, prepaid custodial balance)')
  .option('--buyer <id>', 'Buyer id for --rail balance (defaults to the persisted one)')
  .option('--pack <amount>', '--rail balance: top-up pack to scan when the balance is short (defaults to the server pack)')
  .option('--no-auto-topup', '--rail balance: fail on an insufficient balance instead of prompting a top-up')
  .option('--topup-mode <mode>', '--rail balance: "auto" (block through the scan, default) or "manual" (create order, show QR, exit for later confirm)', 'auto')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, service, paramsJson, options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });
    const useAlipay = options.rail?.toLowerCase() === 'alipay';
    const useWechat = options.rail?.toLowerCase() === 'wechat';
    const useBalance = options.rail?.toLowerCase() === 'balance';

    // The fiat rails (Alipay/WeChat) are scan-to-pay and the balance rail is
    // prepaid — none of them need an EVM wallet.
    if (!useAlipay && !useWechat && !useBalance && !client.isInitialized) {
      console.error('❌ Wallet not initialized. Run: moltspay init');
      process.exit(1);
    }

    // Build params from JSON string or options
    let params: Record<string, any> = {};
    let useRawData = false;
    
    // --data flag: raw JSON for custom input formats (takes priority)
    if (options.data) {
      try {
        params = JSON.parse(options.data);
        useRawData = true;
      } catch {
        console.error('❌ Invalid JSON in --data flag');
        process.exit(1);
      }
    } else if (paramsJson) {
      try {
        params = JSON.parse(paramsJson);
      } catch {
        console.error('❌ Invalid JSON params');
        process.exit(1);
      }
    }
    
    // Override with CLI options (only if not using --data)
    if (!useRawData && options.prompt) params.prompt = options.prompt;
    
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

    // USDT requires gas - check native balance (EVM rails only)
    if (!useAlipay && !useWechat && !useBalance && token === 'USDT') {
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
      if (useRawData) {
        console.log(`   Data: ${JSON.stringify(params).slice(0, 50)}${JSON.stringify(params).length > 50 ? '...' : ''}`);
      } else {
        console.log(`   Prompt: ${params.prompt}`);
      }
      if (imageDisplay) console.log(`   Image: ${imageDisplay}`);
      if (useAlipay) {
        console.log(`   Rail: alipay (CNY via alipay-bot)`);
      } else if (useWechat) {
        console.log(`   Rail: wechat (CNY via WeChat Native, scan to pay)`);
      } else if (useBalance) {
        console.log(`   Rail: balance (password-free, prepaid custodial balance)`);
      } else {
        console.log(`   Chain: ${chain || '(auto)'}`);  // Will be determined by server
        console.log(`   Token: ${token}`);
        console.log(`   Wallet: ${client.address}`);
      }
      console.log('');
    }

    try {
      // All chains use the same pay() flow - protocol detection happens inside.
      // --rail alipay dispatches to the alipay-bot-backed AlipayClient, which
      // streams CLI output verbatim and surfaces the payment URL to the user.
      // --rail wechat dispatches to WechatClient: it renders the Native code_url
      // as terminal/media QR and polls until the scanned order is verified paid.
      const railOptions = useAlipay ? {
        rail: 'alipay',
        rawData: useRawData,
        onPaymentPending: ({ paymentUrl, shortenUrl }: { paymentUrl: string; shortenUrl?: string; tradeNo: string }) => {
          if (!options.json) {
            process.stdout.write(`\n📲 Scan with Alipay or open: ${shortenUrl ?? paymentUrl}\n\n`);
          }
        },
        onLine: (line: string) => { if (!options.json) process.stdout.write(line + '\n'); },
      } : useWechat ? {
        rail: 'wechat',
        rawData: useRawData,
        onPaymentPending: ({ paymentUrl, tradeNo }: { paymentUrl: string; shortenUrl?: string; tradeNo: string }) => {
          if (!options.json) {
            const qrPath = writeQRCodePng(paymentUrl, { filename: `wechat-${tradeNo}.png` });
            process.stdout.write(`\n📲 Scan with WeChat to pay (order ${tradeNo}):\n`);
            process.stdout.write(`MEDIA: ${qrPath}\n`);
            // Render the weixin:// code_url as a scannable terminal QR.
            void printQRCode(paymentUrl);
            process.stdout.write(
              `\n   QR image: ${qrPath}\n` +
              `   The Native code_url is QR payload, not a browser checkout link.\n` +
              `   Waiting for payment...\n\n`,
            );
          }
        },
      } : useBalance ? {
        rail: 'balance',
        rawData: useRawData,
        buyerId: options.buyer,
        topupPack: options.pack,
        // commander sets options.autoTopup=false for --no-auto-topup.
        autoTopup: options.autoTopup,
        topupMode: options.topupMode,
        onTopupRequired: (pack: string, codeUrl: string) => {
          if (!options.json) {
            const qrPath = writeQRCodePng(codeUrl, { filename: `wechat-topup-${pack}.png` });
            process.stdout.write(`\n💳 Insufficient balance. Scan with WeChat to top up ${pack}:\n`);
            process.stdout.write(`MEDIA: ${qrPath}\n`);
            void printQRCode(codeUrl);
            process.stdout.write(`\n   QR image: ${qrPath}\n   Waiting for the top-up to credit...\n\n`);
          }
        },
        onTopupCredited: (balance: string) => {
          if (!options.json) process.stdout.write(`\n✅ Topped up, balance ${balance}. Continuing password-free payment...\n`);
        },
      } : {
        token: token as 'USDC' | 'USDT',
        chain,
        rawData: useRawData
      };
      const result = await client.pay(server, service, params, railOptions as any);

      // Manual top-up mode: pay() returns a topup_required sentinel (QR already
      // surfaced via onTopupRequired); tell the caller how to confirm + resume.
      if (result && (result as any).status === 'topup_required') {
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          const otn = (result as any).out_trade_no;
          console.log(`\n⏳ Insufficient balance. Created top-up order ${otn}`);
          console.log(`   After paying, run: moltspay balance topup-confirm ${otn}`);
          console.log(`   Once credited, run: moltspay pay ${server} ${service} --rail balance\n`);
        }
      } else if (options.json) {
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
 * moltspay wechat <start|status|fulfill|cancel|list>
 *
 * Non-blocking, recoverable WeChat Pay Native session commands for channel
 * integrations. `pay --rail wechat` remains the interactive blocking wrapper.
 */
}
