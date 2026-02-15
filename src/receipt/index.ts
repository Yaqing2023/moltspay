/**
 * Receipt - Transaction receipt generation
 * 
 * Generate standardized transaction receipts for reconciliation/reimbursement/audit
 */

import { getChain } from '../chains/index.js';
import type { ChainName, Invoice, VerifyResult } from '../types/index.js';

export interface ReceiptParams {
  /** Invoice ID (auto-generated or specified) */
  invoiceId?: string;
  /** Order ID */
  orderId: string;
  /** Service name */
  service: string;
  /** Service description */
  description?: string;
  /** Amount */
  amount: number;
  /** Token */
  token?: 'USDC' | 'USDT' | 'ETH';
  /** Chain */
  chain: ChainName;
  /** Transaction hash */
  txHash: string;
  /** Payer address */
  payerAddress: string;
  /** Recipient address */
  recipientAddress: string;
  /** Delivery info */
  delivery?: {
    /** Delivery URL */
    url?: string;
    /** File hash */
    fileHash?: string;
    /** Delivery timestamp */
    deliveredAt?: string;
  };
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface Receipt {
  type: 'receipt';
  version: '1.0';
  /** Invoice ID */
  invoiceId: string;
  /** Order ID */
  orderId: string;
  /** Service */
  service: string;
  description?: string;
  /** Amount */
  amount: string;
  token: string;
  /** Chain info */
  chain: string;
  chainId: number;
  /** Transaction info */
  txHash: string;
  txUrl: string;
  /** Parties */
  payer: string;
  recipient: string;
  /** Timestamps */
  paidAt: string;
  issuedAt: string;
  /** Delivery info */
  delivery?: {
    url?: string;
    fileHash?: string;
    deliveredAt?: string;
  };
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Generate invoice ID
 */
function generateInvoiceId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `INV-${date}-${random}`;
}

/**
 * Generate transaction receipt
 */
export function generateReceipt(params: ReceiptParams): Receipt {
  const chainConfig = getChain(params.chain);
  
  return {
    type: 'receipt',
    version: '1.0',
    invoiceId: params.invoiceId || generateInvoiceId(),
    orderId: params.orderId,
    service: params.service,
    description: params.description,
    amount: params.amount.toFixed(2),
    token: params.token || 'USDC',
    chain: chainConfig.name,
    chainId: chainConfig.chainId,
    txHash: params.txHash,
    txUrl: `${chainConfig.explorerTx}${params.txHash}`,
    payer: params.payerAddress,
    recipient: params.recipientAddress,
    paidAt: new Date().toISOString(),
    issuedAt: new Date().toISOString(),
    delivery: params.delivery,
    metadata: params.metadata,
  };
}

/**
 * Generate receipt from Invoice + VerifyResult
 */
export function generateReceiptFromInvoice(
  invoice: Invoice,
  verifyResult: VerifyResult,
  delivery?: ReceiptParams['delivery']
): Receipt {
  if (!verifyResult.verified || !verifyResult.tx_hash) {
    throw new Error('Cannot generate receipt: payment not verified');
  }

  return generateReceipt({
    orderId: invoice.order_id,
    service: invoice.service,
    description: invoice.description,
    amount: parseFloat(invoice.amount),
    token: invoice.token as 'USDC' | 'USDT' | 'ETH',
    chain: invoice.chain as ChainName,
    txHash: verifyResult.tx_hash,
    payerAddress: verifyResult.from || 'unknown',
    recipientAddress: invoice.recipient,
    delivery,
  });
}

/**
 * Format receipt as human-readable message (Markdown)
 */
export function formatReceiptMessage(receipt: Receipt): string {
  let msg = `🧾 **Transaction Receipt**

**Invoice:** \`${receipt.invoiceId}\`
**Order:** \`${receipt.orderId}\`

---

**Service:** ${receipt.service}
${receipt.description ? `**Description:** ${receipt.description}\n` : ''}
**Amount:** ${receipt.amount} ${receipt.token}
**Chain:** ${receipt.chain} (Chain ID: ${receipt.chainId})

---

**Payer:** \`${receipt.payer}\`
**Recipient:** \`${receipt.recipient}\`
**Transaction:** [\`${receipt.txHash.slice(0, 10)}...${receipt.txHash.slice(-8)}\`](${receipt.txUrl})
**Paid at:** ${receipt.paidAt}`;

  if (receipt.delivery) {
    msg += `\n\n---\n\n**Delivery Info:**`;
    if (receipt.delivery.url) {
      msg += `\n- Download: ${receipt.delivery.url}`;
    }
    if (receipt.delivery.fileHash) {
      msg += `\n- Checksum: \`${receipt.delivery.fileHash}\``;
    }
    if (receipt.delivery.deliveredAt) {
      msg += `\n- Delivered at: ${receipt.delivery.deliveredAt}`;
    }
  }

  msg += `\n\n---\n\n_Receipt issued: ${receipt.issuedAt}_`;

  return msg;
}

/**
 * Format receipt as plain text (for Feishu/WhatsApp)
 */
export function formatReceiptText(receipt: Receipt): string {
  let msg = `🧾 Transaction Receipt

Invoice: ${receipt.invoiceId}
Order: ${receipt.orderId}

Service: ${receipt.service}
Amount: ${receipt.amount} ${receipt.token}
Chain: ${receipt.chain}

Payer: ${receipt.payer}
Recipient: ${receipt.recipient}
Tx: ${receipt.txHash}
Explorer: ${receipt.txUrl}
Paid at: ${receipt.paidAt}`;

  if (receipt.delivery) {
    msg += `\n\nDelivery:`;
    if (receipt.delivery.url) {
      msg += `\nDownload: ${receipt.delivery.url}`;
    }
    if (receipt.delivery.fileHash) {
      msg += `\nChecksum: ${receipt.delivery.fileHash}`;
    }
  }

  return msg;
}

/**
 * Format receipt as JSON (for Agent parsing)
 */
export function formatReceiptJson(receipt: Receipt): string {
  return JSON.stringify(receipt, null, 2);
}
