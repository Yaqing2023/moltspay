/**
 * Receipt - 交易收据生成
 * 
 * 用于生成标准化的交易收据，便于对账/报销/审计
 */

import { getChain } from '../chains/index.js';
import type { ChainName, Invoice, VerifyResult } from '../types/index.js';

export interface ReceiptParams {
  /** 发票号（自动生成或指定） */
  invoiceId?: string;
  /** 订单号 */
  orderId: string;
  /** 服务名称 */
  service: string;
  /** 服务描述 */
  description?: string;
  /** 金额 */
  amount: number;
  /** Token */
  token?: 'USDC' | 'USDT' | 'ETH';
  /** 链 */
  chain: ChainName;
  /** 交易 hash */
  txHash: string;
  /** 付款方地址 */
  payerAddress: string;
  /** 收款方地址 */
  recipientAddress: string;
  /** 交付信息 */
  delivery?: {
    /** 交付物 URL */
    url?: string;
    /** 文件 hash */
    fileHash?: string;
    /** 交付时间 */
    deliveredAt?: string;
  };
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

export interface Receipt {
  type: 'receipt';
  version: '1.0';
  /** 发票号 */
  invoiceId: string;
  /** 订单号 */
  orderId: string;
  /** 服务 */
  service: string;
  description?: string;
  /** 金额 */
  amount: string;
  token: string;
  /** 链信息 */
  chain: string;
  chainId: number;
  /** 交易信息 */
  txHash: string;
  txUrl: string;
  /** 参与方 */
  payer: string;
  recipient: string;
  /** 时间 */
  paidAt: string;
  issuedAt: string;
  /** 交付信息 */
  delivery?: {
    url?: string;
    fileHash?: string;
    deliveredAt?: string;
  };
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 生成发票号
 */
function generateInvoiceId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `INV-${date}-${random}`;
}

/**
 * 生成交易收据
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
 * 从 Invoice + VerifyResult 生成收据
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
 * 格式化收据为人类可读消息
 */
export function formatReceiptMessage(receipt: Receipt): string {
  let msg = `🧾 **交易收据**

**发票号:** \`${receipt.invoiceId}\`
**订单号:** \`${receipt.orderId}\`

---

**服务:** ${receipt.service}
${receipt.description ? `**描述:** ${receipt.description}\n` : ''}
**金额:** ${receipt.amount} ${receipt.token}
**链:** ${receipt.chain} (Chain ID: ${receipt.chainId})

---

**付款方:** \`${receipt.payer}\`
**收款方:** \`${receipt.recipient}\`
**交易:** [\`${receipt.txHash.slice(0, 10)}...${receipt.txHash.slice(-8)}\`](${receipt.txUrl})
**支付时间:** ${receipt.paidAt}`;

  if (receipt.delivery) {
    msg += `\n\n---\n\n**交付信息:**`;
    if (receipt.delivery.url) {
      msg += `\n- 下载链接: ${receipt.delivery.url}`;
    }
    if (receipt.delivery.fileHash) {
      msg += `\n- 文件校验: \`${receipt.delivery.fileHash}\``;
    }
    if (receipt.delivery.deliveredAt) {
      msg += `\n- 交付时间: ${receipt.delivery.deliveredAt}`;
    }
  }

  msg += `\n\n---\n\n_收据生成时间: ${receipt.issuedAt}_`;

  return msg;
}

/**
 * 格式化收据为纯文本（适合飞书/WhatsApp）
 */
export function formatReceiptText(receipt: Receipt): string {
  let msg = `🧾 交易收据

发票号: ${receipt.invoiceId}
订单号: ${receipt.orderId}

服务: ${receipt.service}
金额: ${receipt.amount} ${receipt.token}
链: ${receipt.chain}

付款方: ${receipt.payer}
收款方: ${receipt.recipient}
交易: ${receipt.txHash}
查看: ${receipt.txUrl}
支付时间: ${receipt.paidAt}`;

  if (receipt.delivery) {
    msg += `\n\n交付信息:`;
    if (receipt.delivery.url) {
      msg += `\n下载: ${receipt.delivery.url}`;
    }
    if (receipt.delivery.fileHash) {
      msg += `\n校验: ${receipt.delivery.fileHash}`;
    }
  }

  return msg;
}

/**
 * 格式化收据为 JSON（适合 Agent 解析）
 */
export function formatReceiptJson(receipt: Receipt): string {
  return JSON.stringify(receipt, null, 2);
}
