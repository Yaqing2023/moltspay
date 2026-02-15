/**
 * Complete Permit Payment Flow - End-to-End Example
 * 
 * Shows the full conversation between Client and Seller using Permit payment.
 * Client signs a Permit, Seller collects payment.
 */

import { signPermit, PermitWallet, type SignPermitResult } from '../src/wallet/index.js';
import { SellerTemplates, BuyerTemplates } from '../src/templates/index.js';
import { OrderManager, MemoryOrderStore } from '../src/orders/index.js';
import { generateReceiptFromInvoice, formatReceiptText } from '../src/receipt/index.js';

// === Configuration ===
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY!;
const SELLER_PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY!;
const CHAIN = 'base_sepolia' as const;
const SELLER_ADDRESS = '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C';

// === Simulation ===
async function simulatePermitPaymentFlow() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       Complete Permit Payment Flow - Agent Conversation      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Initialize order manager
  const orderManager = new OrderManager({ store: new MemoryOrderStore() });

  // ========== Phase 1: Client Requests Service ==========
  console.log('━━━ Phase 1: Service Request ━━━\n');
  
  const clientRequest = BuyerTemplates.requestService('AI video generation');
  console.log(`[Client] ${clientRequest}\n`);

  // ========== Phase 2: Seller Creates Invoice & Offers Permit Payment ==========
  console.log('━━━ Phase 2: Quote & Payment Options ━━━\n');
  
  const service = 'AI Video (30s, 1080p, lifestyle theme)';
  const price = 0.99;
  
  // Create order/invoice
  const order = await orderManager.createOrder({
    service,
    price,
    recipient: SELLER_ADDRESS,
    chain: CHAIN,
    expiresInMinutes: 60,
    metadata: { customer: 'client-agent' },
  });
  
  const sellerOffer = SellerTemplates.offerPermitPayment({
    service,
    price,
    sellerAddress: SELLER_ADDRESS,
    chain: CHAIN,
    invoiceId: order.id,
  });
  console.log(`[Seller] ${sellerOffer}\n`);

  // ========== Phase 3: Client Confirms & Signs Permit ==========
  console.log('━━━ Phase 3: Client Signs Permit ━━━\n');
  
  const confirmMsg = BuyerTemplates.confirmPermitPayment();
  console.log(`[Client] ${confirmMsg}\n`);

  // Client signs Permit
  console.log('[Client] (Signing Permit...)\n');
  const permit = await signPermit(
    { chain: CHAIN, privateKey: CLIENT_PRIVATE_KEY },
    {
      spender: SELLER_ADDRESS,
      amount: price,
      deadline: 30, // 30 minutes
    }
  );

  // Client sends Permit data
  const permitMsg = BuyerTemplates.sendPermit({
    permit,
    invoiceId: order.id,
    amount: price,
  });
  console.log(`[Client] ${permitMsg}\n`);

  // ========== Phase 4: Seller Receives Permit & Collects Payment ==========
  console.log('━━━ Phase 4: Seller Collects Payment ━━━\n');
  
  const executingMsg = SellerTemplates.executingPermit(order.id);
  console.log(`[Seller] ${executingMsg}\n`);

  // Seller initializes PermitWallet and collects payment
  console.log('[Seller] (Executing transferWithPermit...)\n');
  
  const sellerWallet = new PermitWallet({
    chain: CHAIN,
    privateKey: SELLER_PRIVATE_KEY,
  });

  const paymentResult = await sellerWallet.transferWithPermit({
    to: SELLER_ADDRESS,
    amount: price,
    permit: {
      owner: permit.owner,
      spender: permit.spender,
      value: permit.value,
      deadline: permit.deadline,
      v: permit.v,
      r: permit.r,
      s: permit.s,
    },
  });

  if (paymentResult.success) {
    // Update order status
    await orderManager.updateStatus(order.id, 'paid', {
      txHash: paymentResult.tx_hash!,
      paidAt: Date.now(),
    });

    const successMsg = SellerTemplates.permitPaymentReceived({
      amount: price,
      txHash: paymentResult.tx_hash!,
      invoiceId: order.id,
    });
    console.log(`[Seller] ${successMsg}\n`);

    // ========== Phase 5: Delivery ==========
    console.log('━━━ Phase 5: Service Delivery ━━━\n');
    
    // (Service processing would happen here)
    const deliveryMsg = SellerTemplates.deliver({
      downloadUrl: 'https://cdn.zen7.ai/videos/v_abc123.mp4',
      fileHash: 'a1b2c3d4e5f6...',
    });
    console.log(`[Seller] ${deliveryMsg}\n`);

    const receivedMsg = BuyerTemplates.deliveryReceived();
    console.log(`[Client] ${receivedMsg}\n`);

    // ========== Phase 6: Receipt ==========
    console.log('━━━ Phase 6: Receipt ━━━\n');
    
    const receipt = generateReceiptFromInvoice({
      invoiceId: order.id,
      service,
      amount: price,
      token: 'USDC',
      chain: CHAIN,
      recipient: SELLER_ADDRESS,
      txHash: paymentResult.tx_hash!,
      delivery: {
        url: 'https://cdn.zen7.ai/videos/v_abc123.mp4',
        hash: 'a1b2c3d4e5f6...',
      },
    });
    
    const receiptText = formatReceiptText(receipt);
    console.log(`[Seller]\n${receiptText}\n`);

    const thankMsg = BuyerTemplates.receiptReceived();
    console.log(`[Client] ${thankMsg}\n`);

    const endMsg = SellerTemplates.end();
    console.log(`[Seller] ${endMsg}\n`);

  } else {
    const failMsg = SellerTemplates.permitPaymentFailed(
      paymentResult.error || 'Unknown error',
      order.id
    );
    console.log(`[Seller] ${failMsg}\n`);
  }

  console.log('━━━ Flow Complete ━━━');
}

// Run
simulatePermitPaymentFlow().catch(console.error);
