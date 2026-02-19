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
 * npx moltspay start <manifest>
 * 
 * Start server from moltspay.services.json
 * Services with "command" field are auto-registered as skills.
 */
program
  .command('start <manifest>')
  .description('Start MoltsPay server from services manifest')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--host <host>', 'Host to bind', '0.0.0.0')
  .option('--facilitator <url>', 'x402 facilitator URL (default: https://x402.org/facilitator)')
  .action(async (manifest, options) => {
    const manifestPath = resolve(manifest);
    
    if (!existsSync(manifestPath)) {
      console.error(`❌ Manifest not found: ${manifestPath}`);
      process.exit(1);
    }

    const port = parseInt(options.port, 10);
    const host = options.host;
    const facilitatorUrl = options.facilitator;

    console.log(`\n🚀 Starting MoltsPay Server (x402 protocol)\n`);
    console.log(`   Manifest: ${manifestPath}`);
    console.log(`   Port: ${port}`);
    console.log('');

    try {
      const server = new MoltsPayServer(manifestPath, { port, host, facilitatorUrl });

      // Get manifest to check for command-based skills
      const manifestContent = await import('fs').then(fs => 
        JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      );

      // Auto-register skills that have a "command" field
      for (const service of manifestContent.services) {
        if (service.command) {
          const workdir = dirname(manifestPath);
          
          server.skill(service.id, async (params) => {
            return new Promise((resolve, reject) => {
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
                // Log stderr in real-time for debugging
                process.stderr.write(data);
              });

              // Send params as JSON to stdin
              proc.stdin.write(JSON.stringify(params));
              proc.stdin.end();

              proc.on('close', (code) => {
                if (code !== 0) {
                  reject(new Error(`Command failed (exit ${code}): ${stderr || 'Unknown error'}`));
                  return;
                }

                // Try to parse output as JSON
                try {
                  const result = JSON.parse(stdout.trim());
                  resolve(result);
                } catch {
                  // If not JSON, return as raw output
                  resolve({ output: stdout.trim() });
                }
              });

              proc.on('error', (err) => {
                reject(new Error(`Failed to spawn command: ${err.message}`));
              });
            });
          });
        }
      }

      // Write PID file
      const pidData = { pid: process.pid, port, manifest: manifestPath };
      writeFileSync(PID_FILE, JSON.stringify(pidData, null, 2));
      console.log(`   PID file: ${PID_FILE}`);
      console.log('');

      // Start listening
      server.listen(port);

      // Cleanup function
      const cleanup = () => {
        try {
          if (existsSync(PID_FILE)) {
            unlinkSync(PID_FILE);
          }
        } catch {}
      };

      // Handle graceful shutdown
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

program.parse();
