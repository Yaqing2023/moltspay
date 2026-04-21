#!/usr/bin/env node
/**
 * Phase 0 — Tempo EIP-2612 Permit probe
 *
 * Verifies end-to-end that pathUSD on Tempo Moderato supports EIP-2612 permit
 * by generating two fresh wallets, funding them from the Tempo faucet, and
 * executing a real permit() + transferFrom() round-trip on live testnet.
 *
 * Side task: probes AlphaUSD / BetaUSD / ThetaUSD DOMAIN_SEPARATOR to recover
 * each token's EIP-712 domain name.
 *
 * Usage: node scripts/probe-tempo-permit.mjs
 *
 * Safe to re-run; wallets and results are written to scripts/.probe-tempo-output/.
 */

import { ethers } from 'ethers';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '.probe-tempo-output');
const WALLETS_FILE = join(OUTPUT_DIR, 'wallets.json');
const RESULTS_FILE = join(OUTPUT_DIR, 'results.json');

const RPC = 'https://rpc.moderato.tempo.xyz';
const FAUCET = 'https://docs.tempo.xyz/api/faucet';
const CHAIN_ID = 42431;

const TOKENS = {
  pathUSD:  { address: '0x20c0000000000000000000000000000000000000', expectedName: 'PathUSD' },
  AlphaUSD: { address: '0x20c0000000000000000000000000000000000001', expectedName: null },
  BetaUSD:  { address: '0x20c0000000000000000000000000000000000002', expectedName: null },
  ThetaUSD: { address: '0x20c0000000000000000000000000000000000003', expectedName: null },
};

// Candidate EIP-712 domain names to try for each token
const NAME_CANDIDATES = [
  (sym) => sym,
  (sym) => sym.charAt(0).toUpperCase() + sym.slice(1),
  (sym) => sym.toUpperCase(),
  (sym) => sym.toLowerCase(),
  () => 'USD Coin',
];

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
];

function log(stage, msg) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] [${stage}] ${msg}`);
}

function computeDomainSeparator(name, version, chainId, verifyingContract) {
  const { keccak256, toUtf8Bytes, AbiCoder, getAddress } = ethers;
  const abi = AbiCoder.defaultAbiCoder();
  const typeHash = keccak256(toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const nameHash = keccak256(toUtf8Bytes(name));
  const verHash = keccak256(toUtf8Bytes(version));
  const encoded = abi.encode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [typeHash, nameHash, verHash, chainId, getAddress(verifyingContract)]
  );
  return keccak256(encoded);
}

async function probeTokenDomain(contract, symbolHint) {
  const onChain = await contract.DOMAIN_SEPARATOR();
  const candidates = NAME_CANDIDATES.map(f => f(symbolHint)).filter((v, i, a) => a.indexOf(v) === i);

  for (const candidate of candidates) {
    const computed = computeDomainSeparator(candidate, '1', CHAIN_ID, await contract.getAddress());
    if (computed.toLowerCase() === onChain.toLowerCase()) {
      return { name: candidate, version: '1', onChain, matched: true };
    }
  }
  return { name: null, version: null, onChain, matched: false, triedCandidates: candidates };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForBalance(contract, address, minValue, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bal = await contract.balanceOf(address);
    if (bal >= minValue) return bal;
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for balance on ${address}`);
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  log('init', `Connected to Tempo (chainId=${net.chainId})`);
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`Unexpected chainId: ${net.chainId}, expected ${CHAIN_ID}`);
  }

  // ===== Step 1: Wallets =====
  let walletA, walletB, walletC;
  if (existsSync(WALLETS_FILE)) {
    const saved = JSON.parse(readFileSync(WALLETS_FILE, 'utf-8'));
    walletA = new ethers.Wallet(saved.A.privateKey, provider);
    walletB = new ethers.Wallet(saved.B.privateKey, provider);
    walletC = saved.C.address;
    log('wallets', `Reusing saved wallets from ${WALLETS_FILE}`);
  } else {
    walletA = ethers.Wallet.createRandom().connect(provider);
    walletB = ethers.Wallet.createRandom().connect(provider);
    walletC = ethers.Wallet.createRandom().address;
    writeFileSync(
      WALLETS_FILE,
      JSON.stringify({
        A: { address: walletA.address, privateKey: walletA.privateKey, role: 'owner' },
        B: { address: walletB.address, privateKey: walletB.privateKey, role: 'settler' },
        C: { address: walletC, role: 'payTo' },
      }, null, 2),
      { mode: 0o600 }
    );
    log('wallets', `Generated fresh wallets (saved to ${WALLETS_FILE}, 0600)`);
  }
  log('wallets', `  A (owner,   signs permit)   = ${walletA.address}`);
  log('wallets', `  B (settler, submits txs)    = ${walletB.address}`);
  log('wallets', `  C (payTo,   receives funds) = ${walletC}`);

  const pathUSD = new ethers.Contract(TOKENS.pathUSD.address, ERC20_ABI, provider);

  // ===== Step 2: Faucet =====
  for (const [label, addr] of [['A', walletA.address], ['B', walletB.address]]) {
    const balBefore = await pathUSD.balanceOf(addr);
    if (balBefore > 0n) {
      log('faucet', `Wallet ${label} already funded (${ethers.formatUnits(balBefore, 6)} pathUSD), skipping faucet`);
      continue;
    }
    log('faucet', `Requesting faucet for ${label} (${addr})`);
    const res = await fetch(FAUCET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      log('faucet', `  ERROR: ${data.error || res.statusText}`);
      log('faucet', `  Response: ${JSON.stringify(data)}`);
      throw new Error(`Faucet failed for ${label}`);
    }
    log('faucet', `  Faucet tx hashes: ${data.data?.map(t => t.hash).join(', ') || 'n/a'}`);
    const bal = await waitForBalance(pathUSD, addr, 1n);
    log('faucet', `  Wallet ${label} now has ${ethers.formatUnits(bal, 6)} pathUSD`);
  }

  // ===== Step 3: Probe DOMAIN_SEPARATORs for all 4 tokens =====
  const domainResults = {};
  for (const [symbol, info] of Object.entries(TOKENS)) {
    const contract = new ethers.Contract(info.address, ERC20_ABI, provider);
    try {
      const result = await probeTokenDomain(contract, symbol);
      domainResults[symbol] = result;
      if (result.matched) {
        log('domain', `${symbol.padEnd(10)} → domain.name="${result.name}" version="${result.version}" ✓`);
      } else {
        log('domain', `${symbol.padEnd(10)} → NO MATCH (tried: ${result.triedCandidates.join(', ')})`);
        log('domain', `  on-chain DOMAIN_SEPARATOR: ${result.onChain}`);
      }
    } catch (err) {
      log('domain', `${symbol.padEnd(10)} → probe failed: ${err.message}`);
      domainResults[symbol] = { error: err.message };
    }
  }

  // ===== Step 4: Baseline balances =====
  log('baseline', 'Reading pre-transaction state...');
  const balA_before = await pathUSD.balanceOf(walletA.address);
  const balC_before = await pathUSD.balanceOf(walletC);
  const nonceA_before = await pathUSD.nonces(walletA.address);
  const allowance_before = await pathUSD.allowance(walletA.address, walletB.address);
  log('baseline', `  A pathUSD balance: ${ethers.formatUnits(balA_before, 6)}`);
  log('baseline', `  C pathUSD balance: ${ethers.formatUnits(balC_before, 6)}`);
  log('baseline', `  A nonce: ${nonceA_before}`);
  log('baseline', `  allowance(A, B): ${allowance_before}`);

  // ===== Step 5: Build + sign Permit =====
  const VALUE = 500_000n; // 0.5 pathUSD (6 decimals)
  const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const domain = {
    name: TOKENS.pathUSD.expectedName,
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: TOKENS.pathUSD.address,
  };
  const types = {
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const message = {
    owner:    walletA.address,
    spender:  walletB.address,
    value:    VALUE,
    nonce:    nonceA_before,
    deadline: DEADLINE,
  };

  log('sign', 'Signing EIP-2612 Permit typed data with A...');
  const signature = await walletA.signTypedData(domain, types, message);
  const sig = ethers.Signature.from(signature);
  log('sign', `  signature: ${signature}`);
  log('sign', `  v=${sig.v}, r=${sig.r}, s=${sig.s}`);

  // ===== Step 6: B submits permit() =====
  log('permit', 'Wallet B submits pathUSD.permit(...) ...');
  const pathUSD_B = pathUSD.connect(walletB);
  let permitTx, permitReceipt;
  try {
    permitTx = await pathUSD_B.permit(
      message.owner, message.spender, message.value, message.deadline,
      sig.v, sig.r, sig.s
    );
    log('permit', `  tx hash: ${permitTx.hash}`);
    permitReceipt = await permitTx.wait();
    log('permit', `  confirmed in block ${permitReceipt.blockNumber}, status=${permitReceipt.status}, gasUsed=${permitReceipt.gasUsed}`);
  } catch (err) {
    log('permit', `  FAILED: ${err.message}`);
    throw err;
  }

  // ===== Step 7: Verify intermediate state =====
  const allowance_mid = await pathUSD.allowance(walletA.address, walletB.address);
  const nonceA_mid = await pathUSD.nonces(walletA.address);
  log('verify-mid', `  allowance(A,B) after permit: ${allowance_mid} (expected ${VALUE})`);
  log('verify-mid', `  A nonce after permit: ${nonceA_mid} (expected ${nonceA_before + 1n})`);
  if (allowance_mid !== VALUE) throw new Error(`Allowance mismatch: ${allowance_mid} vs ${VALUE}`);
  if (nonceA_mid !== nonceA_before + 1n) throw new Error(`Nonce mismatch`);

  // ===== Step 8: B submits transferFrom() =====
  log('transfer', 'Wallet B submits pathUSD.transferFrom(A, C, value) ...');
  let transferTx, transferReceipt;
  try {
    transferTx = await pathUSD_B.transferFrom(walletA.address, walletC, VALUE);
    log('transfer', `  tx hash: ${transferTx.hash}`);
    transferReceipt = await transferTx.wait();
    log('transfer', `  confirmed in block ${transferReceipt.blockNumber}, status=${transferReceipt.status}, gasUsed=${transferReceipt.gasUsed}`);
  } catch (err) {
    log('transfer', `  FAILED: ${err.message}`);
    throw err;
  }

  // ===== Step 9: Final state =====
  const balA_after = await pathUSD.balanceOf(walletA.address);
  const balC_after = await pathUSD.balanceOf(walletC);
  const allowance_after = await pathUSD.allowance(walletA.address, walletB.address);
  log('verify-final', `  A pathUSD balance: ${ethers.formatUnits(balA_after, 6)} (delta: ${ethers.formatUnits(balA_after - balA_before, 6)})`);
  log('verify-final', `  C pathUSD balance: ${ethers.formatUnits(balC_after, 6)} (delta: +${ethers.formatUnits(balC_after - balC_before, 6)})`);
  log('verify-final', `  allowance(A,B) after transferFrom: ${allowance_after} (expected 0)`);

  if (balA_before - balA_after !== VALUE) throw new Error(`A balance delta wrong: ${balA_before - balA_after} vs ${VALUE}`);
  if (balC_after - balC_before !== VALUE) throw new Error(`C balance delta wrong`);
  if (allowance_after !== 0n) throw new Error(`Allowance not decremented to 0`);

  log('SUCCESS', 'All assertions passed. EIP-2612 permit + transferFrom end-to-end works on Tempo Moderato.');

  // ===== Step 10: Save results =====
  const results = {
    timestamp: new Date().toISOString(),
    chainId: CHAIN_ID,
    wallets: {
      A: walletA.address,
      B: walletB.address,
      C: walletC,
    },
    domainProbe: domainResults,
    permitTxHash: permitTx.hash,
    permitExplorer: `https://explore.testnet.tempo.xyz/tx/${permitTx.hash}`,
    transferTxHash: transferTx.hash,
    transferExplorer: `https://explore.testnet.tempo.xyz/tx/${transferTx.hash}`,
    gasUsed: {
      permit: permitReceipt.gasUsed.toString(),
      transferFrom: transferReceipt.gasUsed.toString(),
    },
    balances: {
      A_before: balA_before.toString(),
      A_after: balA_after.toString(),
      C_before: balC_before.toString(),
      C_after: balC_after.toString(),
      delta_value: VALUE.toString(),
    },
    nonces: {
      A_before: nonceA_before.toString(),
      A_after: nonceA_mid.toString(),
    },
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  log('SUCCESS', `Results written to ${RESULTS_FILE}`);

  return results;
}

main().catch(err => {
  console.error('\n[FATAL]', err);
  console.error(err.stack);
  process.exit(1);
});
