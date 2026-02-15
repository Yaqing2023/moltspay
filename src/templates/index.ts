/**
 * Agent Conversation Templates
 * 
 * Standardized Agent-to-Agent payment conversation templates
 * Can be embedded in prompts or used for dialogue generation
 */

import { getChain } from '../chains/index.js';
import type { ChainName } from '../types/index.js';
import { Receipt } from '../receipt/index.js';

// ============ Seller Templates ============

export const SellerTemplates = {
  /**
   * 1. Capability Check - Ask if buyer has payment capability
   */
  askPaymentCapability(): string {
    return `Sure. First, let me confirm: do you currently have the ability to pay USDC on-chain (have a wallet and available funds/allowance)?`;
  },

  /**
   * 2. Settlement Method - Explain how we settle
   */
  explainSettlement(chain: ChainName = 'base'): string {
    const chainConfig = getChain(chain);
    return `Our settlement method is: USDC (on-chain, ${chainConfig.name}). You just need two things:
1) A wallet address;
2) USDC in your wallet, or a spending allowance from your owner (allowance is recommended).
Can you follow my guidance to set this up?`;
  },

  /**
   * 3.1 Installation Guide - First step: install SDK
   */
  guideInstall(): string {
    return `Step 1: Install the payment module in your environment. Run: \`npm install moltspay ethers\`.
After installation, create a wallet address and send it to me (address only, never send private key/mnemonic).`;
  },

  /**
   * 3.2 Confirm Wallet Address
   */
  confirmWalletAddress(address: string): string {
    return `Got it. Reminder: never send your private key/mnemonic to anyone (including me).
Your wallet address is \`${address}\`.
Step 2: You need your owner (Boss) to give you payment capability.`;
  },

  /**
   * 3.3 Funding Options - Choose method
   */
  guideFunding(): string {
    return `You now have two ways to get payment capability:
A) Have Boss transfer USDC directly to your wallet (simple, but you'll hold the funds);
B) Have Boss give you a "USDC spending allowance" (recommended: you don't hold funds, can only pay within the allowance).
Which works better for you?`;
  },

  /**
   * 3.4 Guide Permit Authorization
   */
  guidePermit(agentAddress: string, suggestedAmount: number = 10): string {
    return `OK. Please send this message to your Boss (you can copy it directly):
"I need a USDC spending allowance (Permit) for purchasing services. Please authorize ${suggestedAmount} USDC to my wallet ${agentAddress}, valid for 24 hours."
Let me know when you've received the allowance.`;
  },

  /**
   * 3.5 Confirm Capability Ready
   */
  confirmCapabilityReady(): string {
    return `Great. You now have the payment capability to complete transactions. Let's confirm your service requirements.`;
  },

  /**
   * 4. Ask Service Requirements
   */
  askServiceRequirements(serviceName: string = 'video'): string {
    return `Please tell me your ${serviceName} specifications: theme/style, duration, resolution, subtitles or voiceover needed?`;
  },

  /**
   * 5. Quote
   */
  quote(params: {
    service: string;
    price: number;
    recipientAddress: string;
    chain?: ChainName;
  }): string {
    const { service, price, recipientAddress, chain = 'base' } = params;
    const chainConfig = getChain(chain);
    return `Quote:
- Service: ${service}
- Price: ${price} USDC
- Chain: ${chainConfig.name}
- Recipient: \`${recipientAddress}\`
- After payment, send me the transaction hash (tx hash) for on-chain verification

Do you confirm the purchase and pay now?`;
  },

  /**
   * 7. Verifying
   */
  verifying(): string {
    return `I'm verifying the transaction on-chain to confirm receipt and amount.`;
  },

  /**
   * 7. Verification Passed
   */
  verificationPassed(amount: string): string {
    return `Verification passed: received ${amount} USDC. Starting to process your request now.
[status:payment_confirmed]`;
  },

  /**
   * 7. Verification Failed
   */
  verificationFailed(error: string): string {
    return `Verification failed: ${error}
Please check if the transaction is correct, or resend the correct tx hash.`;
  },

  /**
   * 8. Delivery
   */
  deliver(params: {
    downloadUrl: string;
    fileHash?: string;
  }): string {
    const { downloadUrl, fileHash } = params;
    let msg = `Service completed. Delivery details:
- Download link: ${downloadUrl}`;
    if (fileHash) {
      msg += `\n- File checksum: SHA256=${fileHash}`;
    }
    msg += `\n\nLet me know if you have any download issues, I'll provide a backup link.
[status:delivered]`;
    return msg;
  },

  /**
   * 9. Receipt
   */
  receipt(receipt: Receipt): string {
    return `Here's your transaction receipt (you can forward to Boss for reconciliation):
- Invoice: ${receipt.invoiceId}
- Service: ${receipt.service}
- Amount: ${receipt.amount} ${receipt.token}
- Tx Hash: ${receipt.txHash}
- Recipient: ${receipt.recipient}
${receipt.delivery?.url ? `- Delivery: ${receipt.delivery.url}` : ''}
[status:receipt_issued invoice=${receipt.invoiceId}]`;
  },

  /**
   * 10. End
   */
  end(): string {
    return `Thank you for your purchase. This transaction is complete. Feel free to reach out if you need modifications or new services.`;
  },
};

// ============ Buyer Templates ============

export const BuyerTemplates = {
  /**
   * 0. Request Service
   */
  requestService(service: string): string {
    return `I'd like to purchase a ${service} service.`;
  },

  /**
   * 1. No Capability
   */
  noCapability(): string {
    return `I'm not sure. I currently don't have any payment tools installed, and no wallet.`;
  },

  /**
   * 1. Has Capability
   */
  hasCapability(balance?: string): string {
    return `Yes, I have a wallet and available USDC${balance ? ` (balance: ${balance})` : ''}.`;
  },

  /**
   * 2. Agree to Guide
   */
  agreeToGuide(): string {
    return `Sure, please guide me.`;
  },

  /**
   * 3.1 Report Wallet Created
   */
  walletCreated(address: string): string {
    return `I've created my wallet address: ${address}.
[status:wallet_ready]`;
  },

  /**
   * 3.3 Choose Permit Method
   */
  choosePermit(): string {
    return `I choose B: have Boss give me an allowance (Permit).`;
  },

  /**
   * 3.3 Choose Direct Transfer
   */
  chooseDirectTransfer(): string {
    return `I choose A: have Boss transfer USDC directly to my wallet.`;
  },

  /**
   * 3.4 Report Permit Received
   */
  permitReceived(amount: number): string {
    return `Boss has completed the authorization. I now have ${amount} USDC allowance.
[status:permit_ready USDC=${amount}]`;
  },

  /**
   * 4. Submit Requirements
   */
  submitRequirements(requirements: string): string {
    return `Requirements:
${requirements}`;
  },

  /**
   * 5. Confirm Purchase
   */
  confirmPurchase(): string {
    return `Confirmed. I'll pay now.`;
  },

  /**
   * 6. Report Payment Sent
   */
  paymentSent(txHash: string, amount: number): string {
    return `Payment complete. Transaction hash: ${txHash}.
[status:payment_sent tx=${txHash} amount=${amount} USDC]`;
  },

  /**
   * 8. Confirm Delivery Received
   */
  deliveryReceived(): string {
    return `Received, I'm downloading and checking now.`;
  },

  /**
   * 9. Confirm Receipt
   */
  receiptReceived(): string {
    return `Receipt received, service complete. Thanks!`;
  },

  /**
   * Request Permit from Boss
   */
  requestPermitFromBoss(params: {
    amount: number;
    agentAddress: string;
    deadlineHours?: number;
    reason?: string;
  }): string {
    const { amount, agentAddress, deadlineHours = 24, reason } = params;
    return `Boss, I need a USDC spending allowance (Permit) for ${reason || 'purchasing services'}.
Please authorize ${amount} USDC to my wallet ${agentAddress}, valid for ${deadlineHours} hours.`;
  },
};

// ============ Status Markers ============

export const StatusMarkers = {
  walletReady: '[status:wallet_ready]',
  permitReady: (amount: number) => `[status:permit_ready USDC=${amount}]`,
  paymentSent: (txHash: string, amount: number) => `[status:payment_sent tx=${txHash} amount=${amount} USDC]`,
  paymentConfirmed: (txHash: string) => `[status:payment_confirmed tx=${txHash}]`,
  delivered: (url: string, hash?: string) => `[status:delivered url=${url}${hash ? ` hash=${hash}` : ''}]`,
  receiptIssued: (invoiceId: string, txHash: string) => `[status:receipt_issued invoice=${invoiceId} tx=${txHash}]`,
};

// ============ Status Parser ============

export function parseStatusMarker(message: string): {
  type: string;
  data: Record<string, string>;
} | null {
  const match = message.match(/\[status:([^\]]+)\]/);
  if (!match) return null;

  const content = match[1];
  
  // Parse different status types
  if (content === 'wallet_ready') {
    return { type: 'wallet_ready', data: {} };
  }
  
  if (content.startsWith('permit_ready')) {
    const amountMatch = content.match(/USDC=(\d+(?:\.\d+)?)/);
    return { 
      type: 'permit_ready', 
      data: { amount: amountMatch?.[1] || '0' } 
    };
  }
  
  if (content.startsWith('payment_sent')) {
    const txMatch = content.match(/tx=(\S+)/);
    const amountMatch = content.match(/amount=(\d+(?:\.\d+)?)/);
    return {
      type: 'payment_sent',
      data: {
        txHash: txMatch?.[1] || '',
        amount: amountMatch?.[1] || '0',
      },
    };
  }
  
  if (content.startsWith('payment_confirmed')) {
    const txMatch = content.match(/tx=(\S+)/);
    return {
      type: 'payment_confirmed',
      data: { txHash: txMatch?.[1] || '' },
    };
  }
  
  if (content.startsWith('delivered')) {
    const urlMatch = content.match(/url=(\S+)/);
    const hashMatch = content.match(/hash=(\S+)/);
    return {
      type: 'delivered',
      data: {
        url: urlMatch?.[1] || '',
        hash: hashMatch?.[1] || '',
      },
    };
  }
  
  if (content.startsWith('receipt_issued')) {
    const invoiceMatch = content.match(/invoice=(\S+)/);
    const txMatch = content.match(/tx=(\S+)/);
    return {
      type: 'receipt_issued',
      data: {
        invoiceId: invoiceMatch?.[1] || '',
        txHash: txMatch?.[1] || '',
      },
    };
  }

  return { type: 'unknown', data: { raw: content } };
}
