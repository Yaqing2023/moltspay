#!/usr/bin/env npx ts-node
/**
 * E2E 测试: 使用 moltspay 的视频服务支付流程
 * 
 * 流程:
 * ① toddMolt 发起视频请求
 * ② m/zen7 生成报价 (moltspay)
 * ③ toddMolt 发起支付
 * ④ m/zen7 验证支付 (moltspay)
 * ⑤ m/zen7 生成视频
 * ⑥ m/zen7 交付视频
 * 
 * 使用方法:
 *   npx ts-node examples/e2e-video-service.ts [--real-payment]
 */

import { PaymentAgent, Wallet, CHAINS } from '../src/index.js';

// 配置
const CONFIG = {
  chain: 'base_sepolia' as const,
  zen7Wallet: process.env.ZEN7_WALLET_ADDRESS || '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
  toddMoltKey: process.env.TODDMOLT_WALLET_KEY || '',
  videoPrice: 2.0,
};

// 模拟视频生成
async function generateVideo(prompt: string): Promise<{ url: string; size: number }> {
  console.log(`\n⏳ 生成视频中... "${prompt.substring(0, 50)}..."`);
  // 实际环境调用 Veo API
  await new Promise(r => setTimeout(r, 1000));
  return {
    url: 'https://storage.example.com/video_abc123.mp4',
    size: 2.9 * 1024 * 1024, // 2.9 MB
  };
}

// 模拟 WhatsApp 推送
async function pushToWhatsApp(videoUrl: string): Promise<boolean> {
  console.log(`\n📱 推送视频到 WhatsApp...`);
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

  // ========== ① 客户请求视频 ==========
  const videoPrompt = 'A happy cat dancing on the beach at sunset';
  console.log('① [toddMolt] 发起视频请求');
  console.log(`   Prompt: ${videoPrompt}`);

  // ========== ② 生成报价 (moltspay) ==========
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

  console.log('\n② [m/zen7] 生成报价');
  console.log(`   Order ID: ${invoice.orderId}`);
  console.log(`   Price: ${invoice.amount} USDC`);
  console.log(`   Recipient: ${invoice.recipient}`);
  console.log(`   Expires: ${new Date(invoice.expiresAt).toISOString()}`);

  // ========== ③ 客户发起支付 ==========
  let txHash: string;
  
  if (realPayment && CONFIG.toddMoltKey) {
    console.log('\n③ [toddMolt] 发起支付 (链上交易)');
    
    const toddWallet = new Wallet({
      chain: CONFIG.chain,
      privateKey: CONFIG.toddMoltKey,
    });

    const balance = await toddWallet.getBalance();
    console.log(`   toddMolt USDC Balance: ${balance}`);

    if (balance < CONFIG.videoPrice) {
      console.error(`   ❌ 余额不足! 需要 ${CONFIG.videoPrice} USDC`);
      process.exit(1);
    }

    const result = await toddWallet.transfer(CONFIG.zen7Wallet, CONFIG.videoPrice);
    if (!result.success) {
      console.error(`   ❌ 转账失败: ${result.error}`);
      process.exit(1);
    }

    txHash = result.txHash!;
    console.log(`   ✅ 转账成功!`);
    console.log(`   Tx Hash: ${txHash}`);
  } else {
    // 模拟支付
    console.log('\n③ [toddMolt] 发起支付 (模拟)');
    txHash = '0x' + 'a'.repeat(64); // mock tx hash
    console.log(`   Amount: ${CONFIG.videoPrice} USDC`);
    console.log(`   To: ${CONFIG.zen7Wallet}`);
    console.log(`   ✅ 模拟转账成功!`);
    console.log(`   Tx Hash: ${txHash} (mock)`);
  }

  // ========== ④ 验证支付 (moltspay) ==========
  console.log('\n④ [m/zen7] 验证支付');
  
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
      console.error(`   ❌ 支付验证失败: ${verification.error}`);
      process.exit(1);
    }
  } else {
    // 模拟验证
    console.log(`   ✅ Verified: True (模拟)`);
  }

  // ========== ⑤ 生成视频 ==========
  console.log('\n⑤ [m/zen7] 生成视频');
  const video = await generateVideo(videoPrompt);
  console.log(`   ✅ 视频生成完成`);
  console.log(`   URL: ${video.url}`);
  console.log(`   Size: ${(video.size / 1024 / 1024).toFixed(2)} MB`);

  // ========== ⑥ 交付视频 ==========
  console.log('\n⑥ [m/zen7] 交付视频');
  console.log(`   ✅ 视频已准备交付`);

  // ========== ⑦ 客户收到视频 ==========
  console.log('\n⑦ [toddMolt] 收到视频');
  console.log(`   ✅ 收到 ${(video.size / 1024 / 1024).toFixed(2)} MB`);

  // ========== ⑧ 推送通知 ==========
  console.log('\n⑧ 推送给主人 WhatsApp');
  const pushed = await pushToWhatsApp(video.url);
  console.log(`   ✅ 推送${pushed ? '成功' : '失败'}`);

  // ========== 结果汇总 ==========
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('   ✅ E2E 测试完成');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Order ID: ${invoice.orderId}`);
  console.log(`Tx Hash: ${txHash}`);
  console.log(`Video Size: ${(video.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Real Payment: ${realPayment}`);
}

main().catch(console.error);
