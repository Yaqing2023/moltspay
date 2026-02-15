/**
 * Owner-Agent Allowance Pattern (Recommended)
 * 
 * This is the recommended way for AI Agents to handle payments:
 * - Agent doesn't hold USDC, only a small amount of ETH for gas
 * - Owner (human) signs a Permit in MetaMask granting allowance
 * - Agent spends from Owner's wallet within the allowance
 * 
 * Flow:
 * 1. Agent generates permit instructions for Owner
 * 2. Owner signs in MetaMask (off-chain, no gas)
 * 3. Owner sends signature to Agent
 * 4. Agent stores permit and spends as needed
 */

import { 
  AllowanceWallet, 
  generatePermitInstructions,
  type OwnerPermit 
} from '../src/wallet/index.js';

// === Configuration ===
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY!;  // Only for gas!
const CHAIN = 'base_sepolia' as const;

async function demo() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         Owner-Agent Allowance Pattern Demo                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 1. Initialize Agent's AllowanceWallet
  const agent = new AllowanceWallet({
    chain: CHAIN,
    privateKey: AGENT_PRIVATE_KEY,
  });
  
  console.log(`Agent address: ${agent.address}`);
  console.log(`Agent gas balance: ${await agent.getGasBalance()} ETH\n`);

  // 2. Generate instructions for Owner to sign Permit
  console.log('━━━ Step 1: Request Allowance from Owner ━━━\n');
  
  const OWNER_ADDRESS = '0xYOUR_METAMASK_ADDRESS';  // Owner's MetaMask
  const ALLOWANCE_AMOUNT = 50;  // $50 USDC allowance
  
  const { instructions } = generatePermitInstructions({
    ownerAddress: OWNER_ADDRESS,
    agentAddress: agent.address,
    amount: ALLOWANCE_AMOUNT,
    deadlineHours: 168,  // 1 week
    chain: CHAIN,
  });
  
  console.log(instructions);
  
  // 3. After Owner signs, they send us the permit data
  console.log('\n━━━ Step 2: Owner Signs & Sends Permit ━━━\n');
  
  // This would come from Owner after they sign in MetaMask
  const ownerPermit: OwnerPermit = {
    owner: OWNER_ADDRESS,
    value: '50000000',  // 50 USDC (6 decimals)
    deadline: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,  // 1 week
    nonce: 0,  // Get from contract
    v: 28,
    r: '0x...',  // From signature
    s: '0x...',  // From signature
  };
  
  // Store the permit
  agent.storePermit(ownerPermit);
  console.log('Permit stored from Owner:', ownerPermit.owner);
  
  // 4. Check allowance status
  console.log('\n━━━ Step 3: Check Status ━━━\n');
  
  // Note: This will show 0 until permit is submitted on-chain
  // The permit gets submitted automatically on first spend
  const status = await agent.checkAllowance(OWNER_ADDRESS);
  console.log('Allowance Status:', status);
  
  // 5. Spend to pay for a service
  console.log('\n━━━ Step 4: Pay for Service ━━━\n');
  
  const SERVICE_PROVIDER = '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C';
  
  const result = await agent.spend({
    to: SERVICE_PROVIDER,
    amount: 2.99,
    // permit is already stored, no need to pass again
  });
  
  if (result.success) {
    console.log('✅ Payment successful!');
    console.log(`   From: ${result.from} (Owner)`);
    console.log(`   To: ${result.to}`);
    console.log(`   Amount: ${result.amount} USDC`);
    console.log(`   Remaining allowance: ${result.remainingAllowance} USDC`);
    console.log(`   Tx: ${result.explorerUrl}`);
  } else {
    console.log('❌ Payment failed:', result.error);
  }
}

// === What this looks like in practice ===

/*
CONVERSATION EXAMPLE:

[Agent → Owner]
"I need to purchase a video generation service for $2.99.
Could you grant me a USDC spending allowance?

Here's what you need to do:
1. Open MetaMask
2. Sign this EIP-712 permit (costs no gas)
3. Send me the signature

[Shows permit instructions]"

[Owner → Agent]  
"Done. Here's the signature:
{v: 28, r: '0x...', s: '0x...', deadline: 1707955200, nonce: 5}"

[Agent internally]
agent.storePermit(ownerPermit);
await agent.spend({ to: serviceProvider, amount: 2.99 });

[Agent → Owner]
"Payment complete! Spent $2.99 for video service.
Remaining allowance: $47.01
Tx: https://basescan.org/tx/0x..."
*/

demo().catch(console.error);
