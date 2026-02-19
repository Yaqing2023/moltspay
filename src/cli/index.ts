#!/usr/bin/env node

/**
 * MoltsPay CLI
 * 
 * Commands:
 *   npx moltspay init              - Create wallet, set limits
 *   npx moltspay config            - Update settings
 *   npx moltspay status            - Show wallet and balance
 *   npx moltspay services <url>    - List services from provider
 *   npx moltspay start <manifest>  - Start server from services.json
 */

import { Command } from 'commander';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { MoltsPayClient } from '../client/index.js';
import { MoltsPayServer } from '../server/index.js';
import * as readline from 'readline';

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
  .version('1.0.0');

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
    console.log('\n🔐 MoltsPay Client Setup\n');

    // Check if already initialized
    if (existsSync(join(options.configDir, 'wallet.json'))) {
      console.log('⚠️  Already initialized. Use "moltspay config" to update settings.');
      console.log(`   Config dir: ${options.configDir}`);
      return;
    }

    // Get options interactively if not provided
    let chain = options.chain;
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
    
    let balance = { usdc: 0, native: 0 };
    try {
      balance = await client.getBalance();
    } catch (err: any) {
      console.error('Warning: Could not fetch balance:', err.message);
    }

    if (options.json) {
      console.log(JSON.stringify({
        address: client.address,
        chain: config.chain,
        balance,
        limits: config.limits,
      }, null, 2));
    } else {
      console.log('\n📊 MoltsPay Status\n');
      console.log(`   Wallet: ${client.address}`);
      console.log(`   Chain: ${config.chain}`);
      console.log(`   Balance: ${balance.usdc.toFixed(2)} USDC`);
      console.log(`   Native: ${balance.native.toFixed(6)} ETH`);
      console.log('');
      console.log('   Limits:');
      console.log(`     Max per tx: $${config.limits.maxPerTx}`);
      console.log(`     Max per day: $${config.limits.maxPerDay}`);
      console.log('');
    }
  });

/**
 * npx moltspay services <url>
 */
program
  .command('services <url>')
  .description('List services from a provider')
  .option('--json', 'Output as JSON')
  .action(async (url, options) => {
    try {
      const client = new MoltsPayClient();
      const services = await client.getServices(url);

      if (options.json) {
        console.log(JSON.stringify(services, null, 2));
      } else {
        console.log(`\n🏪 ${services.provider.name}\n`);
        console.log(`   ${services.provider.description || ''}`);
        console.log(`   Wallet: ${services.provider.wallet}`);
        console.log(`   Chain: ${services.provider.chain}`);
        console.log('\n📦 Services:\n');
        
        for (const svc of services.services) {
          const status = svc.available ? '✅' : '❌';
          console.log(`   ${status} ${svc.id}`);
          console.log(`      ${svc.name} - $${svc.price} ${svc.currency}`);
          if (svc.description) {
            console.log(`      ${svc.description}`);
          }
          console.log('');
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
          const indexPath = join(skillDir, 'index.js');
          if (existsSync(indexPath)) {
            try {
              skillModule = await import(indexPath);
              console.log(`   ✅ Loaded module: ${indexPath}`);
            } catch (err: any) {
              console.error(`   ⚠️  Failed to load module: ${err.message}`);
            }
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
 */
program
  .command('pay <server> <service> [params]')
  .description('Pay for a service and get the result')
  .option('--prompt <text>', 'Prompt for the service')
  .option('--image <path>', 'Image URL or local file path')
  .option('--json', 'Output raw JSON only')
  .action(async (server, service, paramsJson, options) => {
    const client = new MoltsPayClient();

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

    if (!params.prompt) {
      console.error('❌ Missing prompt. Use --prompt or pass JSON params');
      process.exit(1);
    }

    const imageDisplay = params.image_url || (params.image_base64 ? `[local file: ${options.image}]` : null);

    if (!options.json) {
      console.log(`\n💳 MoltsPay - Paying for service\n`);
      console.log(`   Server: ${server}`);
      console.log(`   Service: ${service}`);
      console.log(`   Prompt: ${params.prompt}`);
      if (imageDisplay) console.log(`   Image: ${imageDisplay}`);
      console.log(`   Wallet: ${client.address}`);
      console.log('');
    }

    try {
      const result = await client.pay(server, service, params);
      
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
