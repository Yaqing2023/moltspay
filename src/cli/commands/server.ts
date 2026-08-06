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

export function registerServer(program: Command): void {
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
 * moltspay stop
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
 * moltspay pay <server> <service> <params>
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
}
