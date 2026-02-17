/**
 * Deferred Payment Conversation Templates
 * 
 * Natural language templates for Agent-to-Agent deferred payment flows.
 */

import type {
  CreditAccount,
  DeferredPayment,
  CreditTransaction,
} from './types.js';
import type { AccountSummary } from './DeferredPaymentManager.js';

// ============ Status Markers ============

export const DeferredStatusMarkers = {
  creditAccountCreated: (accountId: string, limit: number) =>
    `[status:credit_account_created id=${accountId} limit=${limit} USDC]`,
  
  chargeAdded: (paymentId: string, amount: number) =>
    `[status:charge_added payment=${paymentId} amount=${amount} USDC]`,
  
  settlementReceived: (paymentId: string, txHash: string, amount: number) =>
    `[status:settlement_received payment=${paymentId} tx=${txHash} amount=${amount} USDC]`,
  
  accountSettled: (accountId: string, txHash: string, amount: number) =>
    `[status:account_settled id=${accountId} tx=${txHash} amount=${amount} USDC]`,
  
  creditIssued: (accountId: string, amount: number) =>
    `[status:credit_issued id=${accountId} amount=${amount} USDC]`,
  
  accountSuspended: (accountId: string, reason: string) =>
    `[status:account_suspended id=${accountId} reason="${reason}"]`,
  
  paymentOverdue: (paymentId: string, amount: number) =>
    `[status:payment_overdue payment=${paymentId} amount=${amount} USDC]`,
};

// ============ Seller Templates ============

export const DeferredSellerTemplates = {
  /**
   * Offer deferred payment option
   */
  offerDeferredPayment: (params: {
    service: string;
    price: number;
    netDays?: number;
  }) => {
    const days = params.netDays || 30;
    return `I can offer you two payment options for ${params.service}:

**Option A: Pay Now**
- Price: ${params.price} USDC
- Pay via on-chain transfer, service delivered immediately

**Option B: Pay Later (Net-${days})**
- Price: ${params.price} USDC
- Service delivered now, pay within ${days} days
- Requires a credit account (I can set one up for you)

Which option do you prefer?`;
  },
  
  /**
   * Explain credit account setup
   */
  explainCreditAccount: () => `
To use deferred payment, I'll set up a credit account for you. Here's how it works:

1. **Credit Limit** - I'll extend you a credit line (e.g., $100 USDC)
2. **Use Services** - Each service gets charged to your account
3. **Pay Later** - Settle your balance whenever you want, or by the due date
4. **On-chain Settlement** - When you pay, send USDC to my address and share the tx hash

Would you like me to set up a credit account for you?`,

  /**
   * Confirm credit account creation
   */
  creditAccountCreated: (account: CreditAccount) => 
    `Great! I've set up a credit account for you.

**Account Details:**
- Account ID: ${account.accountId}
- Credit Limit: $${account.creditLimit.toFixed(2)} USDC
- Payment Terms: Net-${account.terms.netDays}
- Current Balance: $${account.balance.toFixed(2)}

You can now use services on credit. I'll track charges and you can settle anytime.
${DeferredStatusMarkers.creditAccountCreated(account.accountId, account.creditLimit)}`,

  /**
   * Charge confirmation
   */
  chargeConfirmation: (payment: DeferredPayment, availableCredit: number) => 
    `Service charged to your account.

**Charge Details:**
- Service: ${payment.service}
- Amount: $${payment.amount.toFixed(2)} USDC
- Order ID: ${payment.orderId}
- Due Date: ${new Date(payment.dueDate).toLocaleDateString()}

**Account Status:**
- Available Credit: $${availableCredit.toFixed(2)} USDC

I'll proceed with your service now.
${DeferredStatusMarkers.chargeAdded(payment.paymentId, payment.amount)}`,

  /**
   * Credit limit exceeded
   */
  creditLimitExceeded: (params: {
    requested: number;
    available: number;
    balance: number;
    limit: number;
  }) => 
    `Sorry, this charge would exceed your credit limit.

**Current Status:**
- Credit Limit: $${params.limit.toFixed(2)} USDC
- Current Balance: $${params.balance.toFixed(2)} USDC
- Available Credit: $${params.available.toFixed(2)} USDC
- Requested: $${params.requested.toFixed(2)} USDC

You can either:
1. **Settle some balance** - Pay down your balance to free up credit
2. **Pay for this service directly** - Skip credit, pay on-chain now
3. **Request credit increase** - Ask for a higher limit (subject to approval)

What would you like to do?`,

  /**
   * Account summary/statement
   */
  accountStatement: (summary: AccountSummary) => {
    const { account, pendingPayments, overduePayments } = summary;
    
    let statement = `**Account Statement**
- Account ID: ${account.accountId}
- Status: ${account.status.toUpperCase()}
- Credit Limit: $${account.creditLimit.toFixed(2)} USDC
- Current Balance: $${account.balance.toFixed(2)} USDC
- Available Credit: $${summary.availableCredit.toFixed(2)} USDC

`;
    
    if (pendingPayments.length > 0) {
      statement += `**Pending Charges (${pendingPayments.length}):**\n`;
      for (const p of pendingPayments) {
        statement += `- ${p.service}: $${p.amount.toFixed(2)} (due ${new Date(p.dueDate).toLocaleDateString()})\n`;
      }
      statement += '\n';
    }
    
    if (overduePayments.length > 0) {
      statement += `**⚠️ OVERDUE (${overduePayments.length}):**\n`;
      for (const p of overduePayments) {
        statement += `- ${p.service}: $${p.amount.toFixed(2)} (was due ${new Date(p.dueDate).toLocaleDateString()})\n`;
      }
      statement += '\n';
    }
    
    if (account.balance > 0) {
      statement += `**To Settle:**
Send $${account.balance.toFixed(2)} USDC to my address and share the transaction hash.`;
    }
    
    return statement;
  },

  /**
   * Settlement confirmation
   */
  settlementConfirmation: (params: {
    amount: number;
    txHash: string;
    newBalance: number;
    paymentId?: string;
  }) => 
    `Payment received and verified on-chain. Thank you!

**Settlement Details:**
- Amount: $${params.amount.toFixed(2)} USDC
- Transaction: ${params.txHash}
- New Balance: $${params.newBalance.toFixed(2)} USDC

${params.paymentId ? DeferredStatusMarkers.settlementReceived(params.paymentId, params.txHash, params.amount) : ''}`,

  /**
   * Overdue notice
   */
  overdueNotice: (payments: DeferredPayment[]) => {
    const total = payments.reduce((sum, p) => sum + (p.amount - p.paidAmount), 0);
    
    let notice = `⚠️ **Payment Overdue Notice**

You have ${payments.length} overdue payment(s) totaling $${total.toFixed(2)} USDC:

`;
    
    for (const p of payments) {
      const overdueDays = Math.floor((Date.now() - new Date(p.dueDate).getTime()) / (1000 * 60 * 60 * 24));
      notice += `- ${p.service}: $${(p.amount - p.paidAmount).toFixed(2)} (${overdueDays} days overdue)\n`;
    }
    
    notice += `
Please settle your balance to avoid account suspension. Send USDC to my address and share the transaction hash.`;
    
    return notice;
  },

  /**
   * Credit issued confirmation
   */
  creditIssued: (params: {
    amount: number;
    reason: string;
    newBalance: number;
    accountId: string;
  }) => 
    `I've issued a credit to your account.

**Credit Details:**
- Amount: $${params.amount.toFixed(2)} USDC
- Reason: ${params.reason}
- New Balance: $${params.newBalance.toFixed(2)} USDC

${DeferredStatusMarkers.creditIssued(params.accountId, params.amount)}`,
};

// ============ Buyer Templates ============

export const DeferredBuyerTemplates = {
  /**
   * Request deferred payment
   */
  requestDeferredPayment: (service: string) =>
    `I'd like to use ${service}, but prefer to pay later. Do you offer deferred payment or credit terms?`,

  /**
   * Accept credit account offer
   */
  acceptCreditAccount: () =>
    `Yes, please set up a credit account for me. I'll settle the balance by the due date.`,

  /**
   * Request credit limit increase
   */
  requestCreditIncrease: (currentLimit: number, requestedLimit: number) =>
    `My current credit limit is $${currentLimit.toFixed(2)}. Could you increase it to $${requestedLimit.toFixed(2)}? I have a larger purchase coming up.`,

  /**
   * Request account statement
   */
  requestStatement: () =>
    `Can you show me my current account balance and any pending charges?`,

  /**
   * Announce settlement payment
   */
  announceSettlement: (params: {
    amount: number;
    txHash: string;
    accountId?: string;
  }) =>
    `I've sent a payment to settle my balance.

**Payment Details:**
- Amount: $${params.amount.toFixed(2)} USDC
- Transaction Hash: ${params.txHash}

Please verify and update my account.
${params.accountId ? `[status:settlement_sent account=${params.accountId} tx=${params.txHash} amount=${params.amount} USDC]` : ''}`,

  /**
   * Dispute a charge
   */
  disputeCharge: (paymentId: string, reason: string) =>
    `I'd like to dispute charge ${paymentId}. Reason: ${reason}

Please review and let me know how to resolve this.
[status:charge_disputed payment=${paymentId}]`,
};

// ============ Parse Status Markers ============

export interface ParsedDeferredStatus {
  type: string;
  data: Record<string, string>;
}

export function parseDeferredStatusMarker(text: string): ParsedDeferredStatus | null {
  const match = text.match(/\[status:(\w+)\s+(.+?)\]/);
  if (!match) return null;
  
  const type = match[1];
  const dataStr = match[2];
  const data: Record<string, string> = {};
  
  // Parse key=value pairs
  const pairs = dataStr.match(/(\w+)=("[^"]+"|[\w.]+)/g);
  if (pairs) {
    for (const pair of pairs) {
      const [key, ...valueParts] = pair.split('=');
      let value = valueParts.join('=');
      // Remove quotes if present
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      data[key] = value;
    }
  }
  
  return { type, data };
}
