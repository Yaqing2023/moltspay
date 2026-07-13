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

export function registerBalance(program: Command): void {
const balanceCommand = program
  .command('balance')
  .description('Manage the custodial balance rail (password-free payments)');

balanceCommand
  .command('query <server>')
  .description('Show balance, limits, and today\'s spend')
  .option('--buyer <id>', 'Buyer id (defaults to the persisted one)')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const info = await client.getBuyerBalance(server, options.buyer);
      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(`\n💰 Balance for ${info.buyer_id}\n`);
        console.log(`   Balance:      ${info.balance} ${info.currency}`);
        if (info.exists) {
          console.log(`   Today spent:  ${info.today_spent}`);
          console.log(`   Limits:       ${info.single_limit}/tx, ${info.daily_limit}/day`);
          console.log(`   Status:       ${info.status}\n`);
        } else {
          console.log('   (no account yet — top up to create one)\n');
        }
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

balanceCommand
  .command('whoami [server]')
  .description('Show this client\'s balance-rail signer identity (and its account binding if a server is given)')
  .option('--buyer <id>', 'Buyer id (defaults to the persisted one)')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const signer = client.getBalanceSignerAddress();
      const account = server ? await client.getBuyerBalance(server, options.buyer) : null;
      if (options.json) {
        console.log(JSON.stringify({ signer, account }, null, 2));
        return;
      }
      console.log(`\n🔑 Balance signer (this client): ${signer}`);
      if (account) {
        console.log(`   Account:       ${account.buyer_id}`);
        console.log(`   Balance:       ${account.balance} ${account.currency}`);
        const bound = account.signer_address;
        if (!account.exists) console.log('   Binding:       (no account yet — run `balance bind` to create)');
        else if (!bound) console.log('   Binding:       (account has no bound signer yet)');
        else if (bound === signer) console.log('   Binding:       ✅ this client is the bound signer');
        else console.log(`   Binding:       ⚠️  bound to a DIFFERENT signer (${bound})`);
        if (account.wechat_openid) console.log(`   WeChat openid: ${account.wechat_openid}`);
      }
      console.log('');
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

balanceCommand
  .command('bind <server>')
  .description('Bind this client to your WeChat account via one top-up (scan to pay); sets the openid + signer binding')
  .option('--pack <amount>', 'Pack amount (defaults to the server default_pack)')
  .option('--buyer <id>', 'Buyer id (defaults to the persisted one)')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const signer = client.getBalanceSignerAddress();
      if (!options.json) process.stdout.write(`\n🔗 Binding this client (${signer}) to your WeChat account…\n`);
      const result = await client.topupBalancePack(server, {
        pack: options.pack,
        buyerId: options.buyer,
        onCodeUrl: (pack: string, codeUrl: string) => {
          if (!options.json) {
            const qrPath = writeQRCodePng(codeUrl, { filename: `wechat-bind-${pack}.png` });
            process.stdout.write(`\n💳 Scan with WeChat to bind (top up ${pack}):\n`);
            process.stdout.write(`MEDIA: ${qrPath}\n`);
            void printQRCode(codeUrl);
            process.stdout.write(`\n   QR image: ${qrPath}\n   Waiting for payment to bind...\n\n`);
          }
        },
      });
      if (options.json) {
        console.log(JSON.stringify({ signer, ...result }, null, 2));
      } else {
        console.log(`\n✅ Bound. This client (${signer}) can now spend the account. Balance ${result.balance}\n`);
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

balanceCommand
  .command('topup <server> <amount>')
  .description('Credit the balance from an externally settled payment')
  .requiredOption('--rail <rail>', 'Settlement rail: crypto | alipay | wechat')
  .option('--buyer <id>', 'Buyer id (defaults to the persisted one)')
  .option('--tx-hash <hash>', 'On-chain tx hash (rail crypto)')
  .option('--chain <chain>', 'Chain of the tx (rail crypto, default base)')
  .option('--trade-no <no>', 'Alipay trade number (rail alipay)')
  .option('--out-trade-no <no>', 'WeChat out_trade_no (rail wechat)')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, amount, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const result = await client.topupBalance(server, {
        rail: options.rail,
        amount,
        buyerId: options.buyer,
        txHash: options.txHash,
        chain: options.chain,
        tradeNo: options.tradeNo,
        outTradeNo: options.outTradeNo,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.replayed) {
        console.log(`\n✅ Already credited (replay). Balance: ${result.balance}\n`);
      } else {
        console.log(`\n✅ Topped up. Balance: ${result.balance} (tx ${result.tx_id})\n`);
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

balanceCommand
  .command('topup-pack <server>')
  .description('Fund the balance by scanning a WeChat top-up pack (creates + confirms the order)')
  .option('--pack <amount>', 'Pack amount (defaults to the server default_pack)')
  .option('--buyer <id>', 'Buyer id (defaults to the persisted one)')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const result = await client.topupBalancePack(server, {
        pack: options.pack,
        buyerId: options.buyer,
        onCodeUrl: (pack: string, codeUrl: string) => {
          if (!options.json) {
            const qrPath = writeQRCodePng(codeUrl, { filename: `wechat-topup-${pack}.png` });
            process.stdout.write(`\n💳 Scan with WeChat to top up ${pack}:\n`);
            process.stdout.write(`MEDIA: ${qrPath}\n`);
            void printQRCode(codeUrl);
            process.stdout.write(`\n   QR image: ${qrPath}\n   Waiting for the top-up to credit...\n\n`);
          }
        },
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✅ Topped up, balance ${result.balance} (tx ${result.txId})\n`);
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// Recoverable balance top-up (2.5): non-blocking order + separate confirm, for
// turn-based agents (openclaw over Discord/WebChat). See the passwordless design
// section 16. topup-pack above stays as the blocking terminal wrapper.
balanceCommand
  .command('topup-order <server>')
  .description('Create a WeChat top-up order and exit (non-blocking); confirm later with topup-confirm')
  .option('--pack <amount>', 'Pack amount (defaults to the server default_pack)')
  .option('--buyer <id>', 'Buyer id (defaults to the persisted one)')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const order = await client.createBalanceTopupOrder(server, { pack: options.pack, buyerId: options.buyer });
      if (options.json) {
        console.log(JSON.stringify({ status: 'topup_required', out_trade_no: order.outTradeNo, code_url: order.codeUrl, pack: order.pack, server_url: server }));
      } else {
        const qrPath = writeQRCodePng(order.codeUrl, { filename: `wechat-topup-${order.pack}.png` });
        process.stdout.write(`\n💳 Scan with WeChat to top up ${order.pack}:\n`);
        process.stdout.write(`MEDIA: ${qrPath}\n`);
        void printQRCode(order.codeUrl);
        process.stdout.write(`\n   QR image: ${qrPath}\n   Order: ${order.outTradeNo}\n   After paying, run: moltspay balance topup-confirm ${order.outTradeNo}\n\n`);
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

balanceCommand
  .command('topup-confirm <out_trade_no>')
  .description('Confirm a top-up order once (or poll for --wait seconds); credits if paid')
  .option('--server <url>', 'Server URL (defaults to the persisted session)')
  .option('--wait <seconds>', 'Poll for up to N seconds instead of a single check', '0')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (outTradeNo, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const deadline = Date.now() + (parseInt(options.wait, 10) || 0) * 1000;
      let conf = await client.confirmBalanceTopup(outTradeNo, { serverUrl: options.server });
      while (!conf.credited && conf.pending && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        conf = await client.confirmBalanceTopup(outTradeNo, { serverUrl: options.server });
      }
      if (options.json) {
        console.log(JSON.stringify(conf));
      } else if (conf.credited) {
        console.log(`\n✅ Topped up, balance ${conf.balance} (tx ${conf.txId})\n`);
      } else if (conf.pending) {
        console.log(`\n⏳ Not confirmed yet; retry: topup-confirm ${outTradeNo}\n`);
      } else {
        console.error(`❌ ${conf.reason || 'confirm failed'}`);
        process.exit(1);
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

balanceCommand
  .command('topup-status <out_trade_no>')
  .description('Show a persisted top-up session (status/pack/expiry) without hitting the gateway')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action((outTradeNo, options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });
    const s = client.getBalanceTopupSession(outTradeNo);
    if (!s) {
      if (options.json) console.log(JSON.stringify({ error: 'session not found' }));
      else console.error(`❌ No session for ${outTradeNo}`);
      process.exit(1);
    }
    if (options.json) console.log(JSON.stringify(s, null, 2));
    else console.log(`\n${s.out_trade_no}  ${s.status}  pack ${s.pack}  buyer ${s.buyer_id}\n   created ${s.created_at}  expires ${s.expires_at}\n`);
  });

balanceCommand
  .command('topup-list')
  .description('List persisted top-up sessions, newest first')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action((options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });
    const sessions = client.listBalanceTopupSessions();
    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
    } else {
      console.log('\nTop-up sessions\n');
      for (const s of sessions) {
        console.log(`   ${s.created_at}  ${s.out_trade_no}  ${s.status.padEnd(9)} pack ${s.pack}  buyer ${s.buyer_id}`);
      }
      if (sessions.length === 0) console.log('   (none)');
      console.log('');
    }
  });

balanceCommand
  .command('transactions <server>')
  .description('List ledger transactions, newest first')
  .option('--buyer <id>', 'Buyer id (defaults to the persisted one)')
  .option('--limit <n>', 'Page size', '20')
  .option('--offset <n>', 'Page offset', '0')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const data = await client.listBalanceTransactions(server, {
        buyerId: options.buyer,
        limit: parseInt(options.limit, 10),
        offset: parseInt(options.offset, 10),
      });
      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`\nTransactions for ${data.buyer_id}\n`);
        for (const t of data.transactions) {
          console.log(`   ${t.created_at}  ${t.type.padEnd(6)} ${t.amount.padStart(8)}  ${t.status.padEnd(9)} ${t.service ?? t.description ?? ''}`);
        }
        if (data.transactions.length === 0) console.log('   (none)');
        console.log('');
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

balanceCommand
  .command('set-buyer <id>')
  .description('Persist the buyer id used by pay --rail balance')
  .option('--config-dir <dir>', 'Config directory', DEFAULT_CONFIG_DIR)
  .action((id, options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });
    client.setBuyerId(id);
    console.log(`✅ Buyer id saved: ${id}`);
  });

/**
 * npx moltspay alipay <action> [args...]
 *
 * Thin pass-through to alipay-bot for first-time Alipay wallet setup (design
 * §5.2.9). Forwards stdout/stderr verbatim with the AIPAY_* env whitelist so
 * interactive `apply`/`bind` prompts work. These are user-driven account
 * actions, intentionally NOT part of the automated pay402() state machine.
 */
}
