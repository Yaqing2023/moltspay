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

export function registerMisc(program: Command): void {
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
 * moltspay start <paths...>
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
  .command('alipay <action> [args...]')
  .description('Alipay wallet setup via alipay-bot: check | apply | bind')
  .allowUnknownOption()
  .action(async (action: string, args: string[]) => {
    // Real alipay-bot subcommand names (verified against alipay-bot-cli 0.3.15).
    const map: Record<string, string> = {
      check: 'check-wallet', apply: 'apply-wallet', bind: 'bind-wallet',
    };
    const sub = map[action] ?? action;
    const child = spawn('alipay-bot', [sub, ...(args ?? [])], {
      stdio: 'inherit',
      env: filterAlipayEnv(process.env),
    });
    child.on('error', (e: any) => {
      if (e?.code === 'ENOENT') {
        console.error(
          '❌ alipay-bot not installed. Run: npx -y @alipay/agent-payment install-cli',
        );
      } else {
        console.error(`❌ ${e.message}`);
      }
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code ?? 1));
  });

/**
 * moltspay validate <path>
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

      // Validate provider.balance (custodial rail, 2.2+/2.3+)
      const chains: string[] = Array.isArray(content.provider?.chains) ? content.provider.chains : [];
      const bal = content.provider?.balance;
      const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
      const toCents = (s: string): number => {
        const [w, f = ''] = s.split('.');
        return parseInt(w, 10) * 100 + parseInt(f.padEnd(2, '0') || '0', 10);
      };
      if (chains.includes('balance') && !bal) {
        errors.push("chains includes 'balance' but provider.balance is missing");
      }
      if (bal) {
        if (!bal.db_path) errors.push('Missing provider.balance.db_path');
        if (bal.currency !== undefined && !['USD', 'CNY'].includes(bal.currency)) {
          errors.push(`provider.balance.currency must be "USD" or "CNY" (got "${bal.currency}")`);
        }
        for (const k of ['single_limit', 'daily_limit', 'default_pack', 'auto_topup_max']) {
          if (bal[k] !== undefined && !AMOUNT_RE.test(String(bal[k]))) {
            errors.push(`provider.balance.${k} must be a decimal string with <= 2 places (got "${bal[k]}")`);
          }
        }
        let packs: string[] | null = null;
        if (bal.topup_packs !== undefined) {
          if (!Array.isArray(bal.topup_packs) || bal.topup_packs.length === 0) {
            errors.push('provider.balance.topup_packs must be a non-empty array');
          } else if (!bal.topup_packs.every((p: any) => typeof p === 'string' && AMOUNT_RE.test(p))) {
            errors.push('provider.balance.topup_packs entries must be decimal strings with <= 2 places');
          } else {
            packs = bal.topup_packs;
          }
        }
        // Cross-field: default_pack must be one of topup_packs
        if (bal.default_pack !== undefined && AMOUNT_RE.test(String(bal.default_pack))) {
          if (!packs) {
            errors.push('provider.balance.default_pack requires a valid provider.balance.topup_packs');
          } else if (!packs.includes(bal.default_pack)) {
            errors.push(`provider.balance.default_pack "${bal.default_pack}" is not in topup_packs [${packs.join(', ')}]`);
          }
        }
        // Cross-field: auto_topup_max must be >= the largest pack
        if (bal.auto_topup_max !== undefined && AMOUNT_RE.test(String(bal.auto_topup_max)) && packs) {
          const maxPack = Math.max(...packs.map(toCents));
          if (toCents(bal.auto_topup_max) < maxPack) {
            errors.push(`provider.balance.auto_topup_max "${bal.auto_topup_max}" is below the largest topup_pack`);
          }
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

/**
 * moltspay transfer <to> <amount> [--token USDC|USDT] [--chain base] [--yes] [--json]
 *
 * Send USDC/USDT out of the wallet to any address (e.g. an exchange deposit
 * address). Thin wrapper over the SDK's Wallet.transfer(). EVM chains only;
 * a normal on-chain transfer (NOT gasless) -- the wallet needs native gas.
 * See docs/SEND-COMMAND-DESIGN.md.
 */
program
  .command('transfer <to> <amount>')
  .description('Transfer USDC/USDT to any address (e.g. an exchange deposit address)')
  .option('--token <token>', 'Token to send: USDC or USDT', 'USDC')
  .option('--chain <chain>', 'EVM chain: base, polygon, bnb, base_sepolia, bnb_testnet, tempo_moderato', 'base')
  .option('--yes', 'Skip the confirmation prompt (for scripts/agents)')
  .option('--json', 'Output raw JSON only')
  .option('--config-dir <dir>', 'Config directory with wallet.json', DEFAULT_CONFIG_DIR)
  .action(async (to, amountStr, options) => {
    const asJson = !!options.json;
    const fail = (msg: string): never => {
      if (asJson) console.log(JSON.stringify({ success: false, error: msg }));
      else console.error(`❌ ${msg}`);
      process.exit(1);
    };

    // Validate chain + token
    const chain = String(options.chain);
    if (isSolanaChain(chain as ChainName)) {
      fail('Solana transfer is not supported yet; use --chain base|polygon|bnb');
    }
    if (!CHAINS[chain as EvmChainName]) {
      fail(`Unknown chain "${chain}". Supported: ${Object.keys(CHAINS).join(', ')}`);
    }
    const token = String(options.token).toUpperCase();
    if (token !== 'USDC' && token !== 'USDT') {
      fail(`Invalid --token "${options.token}" (use USDC or USDT)`);
    }

    // Validate amount + address
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) fail('Invalid amount: must be a positive number');
    let toAddr: string;
    try {
      toAddr = ethers.getAddress(to);
    } catch {
      return fail(`Invalid destination address: ${to}`);
    }

    // Load wallet key
    const walletPath = join(options.configDir || DEFAULT_CONFIG_DIR, 'wallet.json');
    if (!existsSync(walletPath)) fail('Wallet not initialized. Run: moltspay init');
    let privateKey: string | undefined;
    try {
      privateKey = JSON.parse(readFileSync(walletPath, 'utf-8')).privateKey;
    } catch {
      return fail('Could not read wallet.json');
    }
    if (!privateKey) return fail('wallet.json has no privateKey');

    const wallet = new Wallet({ chain: chain as EvmChainName, privateKey });
    const chainConfig = CHAINS[chain as EvmChainName];
    const gas = GAS_SYMBOL[chain] || 'gas';

    // Preflight: token balance + native gas (read-only; transfer() re-checks authoritatively)
    let tokenBal: number, nativeBal: number;
    try {
      tokenBal = Number(await wallet.getTokenBalance(token as TokenSymbol));
      nativeBal = Number(await wallet.getEthBalance());
    } catch (err: any) {
      return fail(`Preflight failed: ${err.message}`);
    }
    if (tokenBal < amount) fail(`Insufficient ${token} on ${chain}: have ${tokenBal}, need ${amount}`);
    if (nativeBal <= 0) fail(`No gas on ${chain}: fund a little ${gas} to cover the transfer`);

    // Confirm (interactive default; --yes / --json skip)
    if (!options.yes && !asJson) {
      console.log(`\n💸 Send ${amount} ${token} on ${chainConfig.name}`);
      console.log(`   From:    ${wallet.address}`);
      console.log(`   To:      ${toAddr}`);
      console.log(`   Network: ${chainConfig.name} (chain id ${chainConfig.chainId}), gas in ${gas}`);
      const answer = await prompt('Type "yes" to confirm: ');
      if (answer.trim().toLowerCase() !== 'yes') {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    // Send
    const r = await wallet.transfer(toAddr, amount, token as TokenSymbol);
    if (asJson) {
      console.log(JSON.stringify(r));
      process.exit(r.success ? 0 : 1);
    }
    if (!r.success) fail(r.error || 'Transfer failed');
    console.log(`\n✅ Sent ${amount} ${token} on ${chainConfig.name}`);
    console.log(`   To:  ${toAddr}`);
    console.log(`   Tx:  ${r.tx_hash}`);
    if (r.explorer_url) console.log(`        ${r.explorer_url}`);
    console.log(`   ⚠️  Ensure the receiver expects ${token} on ${chainConfig.name}.\n`);
  });

}
