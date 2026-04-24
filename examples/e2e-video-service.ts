#!/usr/bin/env npx ts-node
/**
 * E2E test: payment flow for moltspay's video service.
 *
 * Flow:
 * ① toddMolt initiates a video request
 * ② m/zen7 generates an invoice (moltspay)
 * ③ toddMolt initiates payment
 * ④ m/zen7 verifies payment (moltspay)
 * ⑤ m/zen7 generates the video
 * ⑥ m/zen7 delivers the video
 *
 * Usage:
 *   npx ts-node examples/e2e-video-service.ts [--real-payment]
 */

import { PaymentAgent, Wallet, CHAINS } from '../src/index.js';

// Configuration
const CONFIG = {
  chain: 'base_sepolia' as const,
  zen7Wallet: process.env.ZEN7_WALLET_ADDRESS || '0xYOUR_EVM_WALLET_ADDRESS_HERE',
  toddMoltKey: process.env.TODDMOLT_WALLET_KEY || '',
  videoPrice: 2.0,
};

// Mock video generation
async function generateVideo(prompt: string): Promise<{ url: string; size: number }> {
  console.log(`\n⏳ Generating video... "${prompt.substring(0, 50)}..."`);
  // In production this would call the Veo API
  await new Promise(r => setTimeout(r, 1000));
  return {
    url: 'https://storage.example.com/video_abc123.mp4',
    size: 2.9 * 1024 * 1024, // 2.9 MB
  };
}

// Mock WhatsApp push
async function pushToWhatsApp(videoUrl: string): Promise<boolean> {
  console.log(`\n📱 Pushing video to WhatsApp...`);
  await new Promise(r => setTimeout(r, 500));
  return true;
}

async function main() {
  const realPayment = process.argv.includes('--real-payment');

  console.log('═══════════════════════════════════════════════════════');
  console.log('   MoltsPay E2E Test: Video Service Payment Flow');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Chain: ${CONFIG.chain}`);
  console.log(`Real Payment: ${realPayment}`);
  console.log('');

  // ========== ① Customer requests a video ==========
  const videoPrompt = 'A happy cat dancing on the beach at sunset';
  console.log('① [toddMolt] Submits video request');
  console.log(`   Prompt: ${videoPrompt}`);

  // ========== ② Generate invoice (moltspay) ==========
  const paymentAgent = new PaymentAgent({
    chain: CONFIG.chain,
    walletAddress: CONFIG.zen7Wallet,
  });

  const invoice = paymentAgent.createInvoice({
    orderId: `vo_${Date.now().toString(36)}`,
    amount: CONFIG.videoPrice,
    service: 'video_generation',
    expiresMinutes: 30,
    metadata: {
      prompt: videoPrompt,
      requestedBy: 'toddMolt',
    },
  });

  console.log('\n② [m/zen7] Generated invoice');
  console.log(`   Order ID: ${invoice.orderId}`);
  console.log(`   Price: ${invoice.amount} USDC`);
  console.log(`   Recipient: ${invoice.recipient}`);
  console.log(`   Expires: ${new Date(invoice.expiresAt).toISOString()}`);

  // ========== ③ Customer initiates payment ==========
  let txHash: string;

  if (realPayment && CONFIG.toddMoltKey) {
    console.log('\n③ [toddMolt] Initiates payment (on-chain)');

    const toddWallet = new Wallet({
      chain: CONFIG.chain,
      privateKey: CONFIG.toddMoltKey,
    });

    const balance = await toddWallet.getBalance();
    console.log(`   toddMolt USDC Balance: ${balance}`);

    if (balance < CONFIG.videoPrice) {
      console.error(`   ❌ Insufficient balance! Need ${CONFIG.videoPrice} USDC`);
      process.exit(1);
    }

    const result = await toddWallet.transfer(CONFIG.zen7Wallet, CONFIG.videoPrice);
    if (!result.success) {
      console.error(`   ❌ Transfer failed: ${result.error}`);
      process.exit(1);
    }

    txHash = result.txHash!;
    console.log(`   ✅ Transfer successful!`);
    console.log(`   Tx Hash: ${txHash}`);
  } else {
    // Mock payment
    console.log('\n③ [toddMolt] Initiates payment (mock)');
    txHash = '0x' + 'a'.repeat(64); // mock tx hash
    console.log(`   Amount: ${CONFIG.videoPrice} USDC`);
    console.log(`   To: ${CONFIG.zen7Wallet}`);
    console.log(`   ✅ Mock transfer successful!`);
    console.log(`   Tx Hash: ${txHash} (mock)`);
  }

  // ========== ④ Verify payment (moltspay) ==========
  console.log('\n④ [m/zen7] Verifying payment');

  if (realPayment) {
    const verification = await paymentAgent.verifyPayment(txHash, {
      expectedAmount: CONFIG.videoPrice,
      tolerance: 0.01, // 1% tolerance
    });

    console.log(`   Verified: ${verification.verified}`);
    if (verification.verified) {
      console.log(`   Amount: ${verification.amount} USDC`);
      console.log(`   From: ${verification.from}`);
      console.log(`   Block: ${verification.blockNumber}`);
    } else {
      console.error(`   ❌ Payment verification failed: ${verification.error}`);
      process.exit(1);
    }
  } else {
    // Mock verification
    console.log(`   ✅ Verified: True (mock)`);
  }

  // ========== ⑤ Generate video ==========
  console.log('\n⑤ [m/zen7] Generating video');
  const video = await generateVideo(videoPrompt);
  console.log(`   ✅ Video generation complete`);
  console.log(`   URL: ${video.url}`);
  console.log(`   Size: ${(video.size / 1024 / 1024).toFixed(2)} MB`);

  // ========== ⑥ Deliver video ==========
  console.log('\n⑥ [m/zen7] Delivering video');
  console.log(`   ✅ Video ready for delivery`);

  // ========== ⑦ Customer receives video ==========
  console.log('\n⑦ [toddMolt] Receives video');
  console.log(`   ✅ Received ${(video.size / 1024 / 1024).toFixed(2)} MB`);

  // ========== ⑧ Push notification ==========
  console.log('\n⑧ Pushing to owner\'s WhatsApp');
  const pushed = await pushToWhatsApp(video.url);
  console.log(`   ✅ Push ${pushed ? 'succeeded' : 'failed'}`);

  // ========== Summary ==========
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('   ✅ E2E Test Complete');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Order ID: ${invoice.orderId}`);
  console.log(`Tx Hash: ${txHash}`);
  console.log(`Video Size: ${(video.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Real Payment: ${realPayment}`);
}

main().catch(console.error);
