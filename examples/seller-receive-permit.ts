/**
 * Seller Agent - Receive Payment via Permit
 * 
 * Scenario: Client sent a signed Permit, Seller pulls payment.
 * 
 * Flow:
 * 1. Seller receives Permit data from Client
 * 2. Seller uses PermitWallet to pull payment
 * 3. Seller issues receipt and delivers service
 */

import { PermitWallet, type PermitData } from '../src/wallet/index.js';

// === Configuration ===
const SELLER_PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY!;
const CHAIN = 'base_sepolia' as const;

// === Mock: Received Permit from Client ===
const receivedPermit: PermitData = {
  owner: '0xCLIENT_ADDRESS_HERE',
  spender: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C', // Must match Seller's wallet
  value: '990000', // 0.99 USDC (6 decimals)
  deadline: Math.floor(Date.now() / 1000) + 1800, // 30 min from now
  v: 28,
  r: '0x...',
  s: '0x...',
};

const invoiceId = 'INV-20260215-001';
const paymentAmount = 0.99;

async function receivePayment() {
  console.log('=== Seller Agent: Receive Payment via Permit ===\n');
  console.log('Permit received from Client:');
  console.log(`  Client: ${receivedPermit.owner}`);
  console.log(`  Authorized amount: ${Number(receivedPermit.value) / 1e6} USDC`);
  console.log(`  Expires: ${new Date(receivedPermit.deadline * 1000).toISOString()}\n`);

  // 1. Initialize PermitWallet
  const wallet = new PermitWallet({
    chain: CHAIN,
    privateKey: SELLER_PRIVATE_KEY,
  });

  console.log(`Seller wallet: ${wallet.address}`);

  // 2. Verify Seller address matches Permit spender
  if (wallet.address.toLowerCase() !== receivedPermit.spender.toLowerCase()) {
    console.error('ERROR: Permit spender does not match our wallet!');
    return;
  }

  // 3. Check gas balance
  const gasBalance = await wallet.getGasBalance();
  console.log(`Gas balance: ${gasBalance} ETH`);
  
  if (!await wallet.hasEnoughGas()) {
    console.error('ERROR: Insufficient gas (need at least 0.001 ETH)');
    return;
  }

  // 4. Pull payment using Permit
  console.log('\nExecuting Permit payment...');
  const result = await wallet.transferWithPermit({
    to: wallet.address, // Transfer to ourselves
    amount: paymentAmount,
    permit: receivedPermit,
  });

  if (result.success) {
    console.log('\n✅ Payment received successfully!');
    console.log(`  Amount: ${result.amount} USDC`);
    console.log(`  From: ${result.from}`);
    console.log(`  Tx Hash: ${result.tx_hash}`);
    console.log(`  Explorer: ${result.explorer_url}`);
    
    if (result.permitTxHash) {
      console.log(`  Permit Tx: ${result.permitTxHash}`);
    }

    // 5. Issue receipt
    console.log('\n--- Receipt ---');
    console.log(`Invoice: ${invoiceId}`);
    console.log(`Amount: ${paymentAmount} USDC`);
    console.log(`Tx Hash: ${result.tx_hash}`);
    console.log(`[status:payment_confirmed tx=${result.tx_hash}]`);
  } else {
    console.log('\n❌ Payment failed!');
    console.log(`  Error: ${result.error}`);
  }
}

// Run
receivePayment().catch(console.error);
