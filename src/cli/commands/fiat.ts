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

export function registerFiat(program: Command): void {
const wechatCommand = program
  .command('wechat')
  .description('Manage recoverable WeChat Pay Native payment sessions');

wechatCommand
  .command('start <server> <service> [params]')
  .description('Start a WeChat payment session and return QR metadata immediately')
  .option('--prompt <text>', 'Prompt for the service')
  .option('--image <path>', 'Image URL or local file path')
  .option('--data <json>', 'Raw JSON data to send (for custom input formats)')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (server, service, paramsJson, options) => {
    const client = new MoltsPayClient({ configDir: options.configDir });

    let params: Record<string, any> = {};
    let useRawData = false;
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
    if (!useRawData && options.prompt) params.prompt = options.prompt;
    if (options.image) {
      const imagePath = options.image;
      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        params.image_url = imagePath;
      } else {
        const filePath = resolve(imagePath);
        if (!existsSync(filePath)) {
          console.error(`❌ Image file not found: ${filePath}`);
          process.exit(1);
        }
        params.image_base64 = readFileSync(filePath).toString('base64');
      }
    }

    try {
      const session = await client.startWechatPayment(server, service, params, {
        rail: 'wechat',
        rawData: useRawData,
      });
      const qrPath = writeQRCodePng(session.codeUrl, { filename: `wechat-${session.outTradeNo}.png` });
      const output = {
        status: session.status,
        payment_session_id: session.paymentSessionId,
        out_trade_no: session.outTradeNo,
        code_url: session.codeUrl,
        qr_png_path: qrPath,
        expires_at: session.expiresAt,
      };

      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log('\n📲 WeChat payment session started\n');
        console.log(`   Session: ${session.paymentSessionId}`);
        console.log(`   Order:   ${session.outTradeNo}`);
        console.log(`   Expires: ${session.expiresAt}`);
        console.log(`MEDIA: ${qrPath}`);
        await printQRCode(session.codeUrl);
        console.log('\n   The SDK client persisted this session; use:');
        console.log(`   moltspay wechat status ${session.paymentSessionId}\n`);
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

function printWechatSession(session: any, json: boolean): void {
  let parsedResult: unknown;
  if (session.resultBody) {
    try {
      const body = JSON.parse(session.resultBody);
      parsedResult = body.result ?? body;
    } catch {
      parsedResult = session.resultBody;
    }
  }

  const output = {
    status: session.status,
    payment_session_id: session.paymentSessionId,
    out_trade_no: session.outTradeNo,
    expires_at: session.expiresAt,
    last_http_status: session.lastHttpStatus,
    last_error: session.lastError,
    result: parsedResult,
  };
  if (json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\nWeChat payment ${session.status}`);
    console.log(`   Session: ${session.paymentSessionId}`);
    console.log(`   Order:   ${session.outTradeNo}`);
    if (session.lastHttpStatus) console.log(`   HTTP:    ${session.lastHttpStatus}`);
    if (session.lastError) console.log(`   Detail:  ${session.lastError.slice(0, 200)}`);
    if (parsedResult !== undefined) {
      console.log('\nResult:');
      console.log(typeof parsedResult === 'string' ? parsedResult : JSON.stringify(parsedResult, null, 2));
    }
    console.log('');
  }
}

wechatCommand
  .command('status <identifier>')
  .description('Query and recover a WeChat payment session by session id or out_trade_no')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (identifier, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      printWechatSession(await client.getWechatPaymentStatus(identifier), options.json);
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

wechatCommand
  .command('fulfill <identifier>')
  .description('Idempotently fulfill a paid WeChat payment session')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action(async (identifier, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      printWechatSession(await client.fulfillWechatPayment(identifier), options.json);
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

wechatCommand
  .command('cancel <identifier>')
  .description('Cancel a local WeChat payment session')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action((identifier, options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      printWechatSession(client.cancelWechatPayment(identifier), options.json);
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

wechatCommand
  .command('list')
  .description('List persisted WeChat payment sessions')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .option('--json', 'Output raw JSON only')
  .action((options) => {
    try {
      const client = new MoltsPayClient({ configDir: options.configDir });
      const sessions = client.listWechatPaymentSessions();
      if (options.json) {
        console.log(JSON.stringify(sessions, null, 2));
      } else {
        console.log('\nWeChat payment sessions\n');
        for (const s of sessions) {
          console.log(`   ${s.status.padEnd(9)} ${s.paymentSessionId} ${s.outTradeNo} ${s.createdAt}`);
        }
        if (sessions.length === 0) console.log('   (none)');
        console.log('');
      }
    } catch (err: any) {
      if (options.json) console.log(JSON.stringify({ error: err.message }));
      else console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * npx moltspay balance <query|topup|transactions|set-buyer>
 *
 * Custodial balance rail (2.2.0, password-free) management.
 * After a one-time top-up, `pay --rail balance` charges the prepaid
 * balance with no signature or QR per transaction.
 */
}
