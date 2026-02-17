/**
 * Deferred Payment Example
 * 
 * Demonstrates the credit-based pay-later system for Agent-to-Agent transactions.
 */

import {
  DeferredPaymentManager,
  DeferredSellerTemplates,
  DeferredBuyerTemplates,
  JsonDeferredStore,
} from '../dist/index.js';

async function main() {
  console.log('=== Deferred Payment Demo ===\n');

  // Initialize the payment manager
  const manager = new DeferredPaymentManager({
    sellerAddress: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
    sellerId: 'zen7',
    chain: 'base',
    autoVerify: false, // Disable on-chain verification for demo
  });

  // Simulate: Buyer requests deferred payment
  console.log('🤖 Buyer:', DeferredBuyerTemplates.requestDeferredPayment('video generation'));
  console.log();

  // Seller offers deferred payment option
  console.log('🛍️ Seller:', DeferredSellerTemplates.offerDeferredPayment({
    service: 'Video Generation 5s 720p',
    price: 3.99,
    netDays: 30,
  }));
  console.log();

  // Buyer accepts credit account
  console.log('🤖 Buyer:', DeferredBuyerTemplates.acceptCreditAccount());
  console.log();

  // Create credit account
  const account = await manager.createCreditAccount({
    buyerId: 'corina-agent-001',
    creditLimit: 100,
  });

  console.log('🛍️ Seller:', DeferredSellerTemplates.creditAccountCreated(account));
  console.log();

  // Charge for service
  const chargeResult = await manager.charge({
    buyerId: 'corina-agent-001',
    orderId: 'vo_demo_001',
    service: 'Video Generation 5s 720p',
    amount: 3.99,
  });

  if (chargeResult.success && chargeResult.payment) {
    const summary = await manager.getAccountSummary(account.accountId);
    console.log('🛍️ Seller:', DeferredSellerTemplates.chargeConfirmation(
      chargeResult.payment,
      summary?.availableCredit || 0
    ));
    console.log();

    // Add another charge
    const secondCharge = await manager.charge({
      buyerId: 'corina-agent-001',
      orderId: 'vo_demo_002',
      service: 'Image Enhancement',
      amount: 1.50,
    });

    if (secondCharge.success) {
      console.log('🛍️ Seller: Added another charge: $1.50 for Image Enhancement\n');
    }

    // Get statement
    console.log('🤖 Buyer:', DeferredBuyerTemplates.requestStatement());
    console.log();

    const updatedSummary = await manager.getAccountSummary(account.accountId);
    if (updatedSummary) {
      console.log('🛍️ Seller:', DeferredSellerTemplates.accountStatement(updatedSummary));
      console.log();
    }

    // Simulate payment (in real scenario, this would be an on-chain tx)
    const fakeTxHash = '0x' + 'abc123'.repeat(10);
    console.log('🤖 Buyer:', DeferredBuyerTemplates.announceSettlement({
      amount: 5.49,
      txHash: fakeTxHash,
      accountId: account.accountId,
    }));
    console.log();

    // Record settlement
    const settlementResult = await manager.settleAccount(account.accountId, fakeTxHash);
    
    if (settlementResult.success) {
      const finalAccount = await manager.getAccount(account.accountId);
      console.log('🛍️ Seller:', DeferredSellerTemplates.settlementConfirmation({
        amount: 5.49,
        txHash: fakeTxHash,
        newBalance: finalAccount?.balance || 0,
      }));
    }
  }

  console.log('\n=== Demo Complete ===');
}

main().catch(console.error);
