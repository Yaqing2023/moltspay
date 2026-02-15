/**
 * Client Agent - Pay with Permit
 * 
 * Scenario: Client signs a Permit authorizing the Seller to pull payment.
 * More secure than direct transfer (Client only signs, doesn't execute tx).
 * 
 * Flow:
 * 1. Client receives invoice from Seller
 * 2. Client signs Permit authorizing Seller's address
 * 3. Client sends Permit data to Seller
 * 4. Seller uses PermitWallet to pull payment
 */

import { signPermit, type SignPermitResult } from '../src/wallet/index.js';

// === Configuration ===
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY!;
const CHAIN = 'base_sepolia' as const;

// === Mock: Received invoice from Seller ===
const invoice = {
  service: 'AI Video Generation (30s)',
  amount: 0.99,
  sellerAddress: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C', // Zen7's wallet
  invoiceId: 'INV-20260215-001',
};

async function payWithPermit() {
  console.log('=== Client Agent: Pay with Permit ===\n');
  console.log('Invoice received:');
  console.log(`  Service: ${invoice.service}`);
  console.log(`  Amount: ${invoice.amount} USDC`);
  console.log(`  Seller: ${invoice.sellerAddress}`);
  console.log(`  Invoice ID: ${invoice.invoiceId}\n`);

  // 1. Sign Permit authorizing Seller to pull payment
  console.log('Signing Permit...');
  const permit = await signPermit(
    { chain: CHAIN, privateKey: CLIENT_PRIVATE_KEY },
    {
      spender: invoice.sellerAddress,
      amount: invoice.amount,
      deadline: 30, // 30 minutes from now
    }
  );

  console.log('Permit signed successfully!\n');
  console.log('Permit data:');
  console.log(`  Owner (Client): ${permit.owner}`);
  console.log(`  Spender (Seller): ${permit.spender}`);
  console.log(`  Value: ${Number(permit.value) / 1e6} USDC`);
  console.log(`  Deadline: ${new Date(permit.deadline * 1000).toISOString()}`);
  console.log(`  Nonce: ${permit.nonce}`);

  // 2. Format message to send to Seller
  const permitMessage = formatPermitMessage(permit, invoice.invoiceId);
  console.log('\n--- Message to Seller ---\n');
  console.log(permitMessage);

  return permit;
}

/**
 * Format Permit as a message to send to Seller
 */
function formatPermitMessage(permit: SignPermitResult, invoiceId: string): string {
  return `Payment authorized via Permit.

Invoice: ${invoiceId}
Amount: ${Number(permit.value) / 1e6} USDC

Permit Data:
\`\`\`json
${JSON.stringify({
  owner: permit.owner,
  spender: permit.spender,
  value: permit.value,
  deadline: permit.deadline,
  nonce: permit.nonce,
  v: permit.v,
  r: permit.r,
  s: permit.s,
}, null, 2)}
\`\`\`

[status:permit_sent invoice=${invoiceId} amount=${Number(permit.value) / 1e6}]`;
}

// Run
payWithPermit().catch(console.error);
