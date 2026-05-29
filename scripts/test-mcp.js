#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Standalone smoke test for the MoltsPay MCP server.
 *
 * Spawns `moltspay-mcp` (or `node dist/mcp/index.js` as fallback) as a child
 * process, runs the full JSON-RPC handshake, lists tools, and calls
 * `moltspay_status`. Prints every response pretty.
 *
 * Usage (from the repo root, on any OS including Windows):
 *     node scripts/test-mcp.js
 *
 * Exit code: 0 on success, 1 on any protocol/tool error.
 */

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const TIMEOUT_MS = 30_000;

function pickCommand() {
  const distEntry = join(__dirname, '..', 'dist', 'mcp', 'index.js');
  if (existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry], label: `node ${distEntry}` };
  }
  const isWin = process.platform === 'win32';
  return {
    cmd: isWin ? 'moltspay-mcp.cmd' : 'moltspay-mcp',
    args: [],
    label: 'moltspay-mcp (from PATH)',
  };
}

function banner(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

async function main() {
  const { cmd, args, label } = pickCommand();
  console.log(`[test-mcp] launching: ${label}`);

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    process.stderr.write(`[server stderr] ${text}`);
  });

  child.on('error', (err) => {
    console.error(`[test-mcp] failed to spawn: ${err.message}`);
    process.exit(1);
  });

  // Pending JSON-RPC requests keyed by id.
  const pending = new Map();
  let nextId = 1;

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, newlineIdx).trim();
      stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.log(`[server stdout non-json] ${line}`);
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
      }, TIMEOUT_MS);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  function notify(method, params) {
    const payload = { jsonrpc: '2.0', method, params };
    child.stdin.write(JSON.stringify(payload) + '\n');
  }

  let exitCode = 0;
  try {
    banner('1. initialize');
    const initResult = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-mcp', version: '0.0.0' },
    });
    console.log(JSON.stringify(initResult, null, 2));
    if (initResult.error) throw new Error(`initialize failed: ${initResult.error.message}`);

    notify('notifications/initialized');

    banner('2. tools/list');
    const listResult = await request('tools/list', {});
    if (listResult.error) throw new Error(`tools/list failed: ${listResult.error.message}`);
    const toolNames = (listResult.result.tools || []).map((t) => t.name);
    console.log('tools:', toolNames.join(', '));

    banner('3. tools/call moltspay_status');
    const callResult = await request('tools/call', {
      name: 'moltspay_status',
      arguments: {},
    });
    console.log(JSON.stringify(callResult, null, 2));
    if (callResult.error) {
      throw new Error(`tools/call returned JSON-RPC error: ${callResult.error.message}`);
    }
    if (callResult.result && callResult.result.isError) {
      throw new Error(
        `moltspay_status returned isError: ${JSON.stringify(callResult.result.content)}`
      );
    }

    banner('PASS');
    console.log('MCP server healthy, moltspay_status returned successfully.');
    if (stderrBuf.includes('insecure permissions')) {
      console.log(
        '\n[test-mcp] NOTE: server still logged the "insecure permissions" warning — your Windows box is running an older build.'
      );
    }
  } catch (err) {
    exitCode = 1;
    banner('FAIL');
    console.error(err.message);
  } finally {
    child.stdin.end();
    child.kill();
    process.exit(exitCode);
  }
}

main();
