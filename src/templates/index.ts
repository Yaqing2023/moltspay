/**
 * Agent 对话模板
 * 
 * 标准化的 Agent-to-Agent 支付对话模板
 * 可直接嵌入 prompt 或用于生成对话
 */

import { getChain } from '../chains/index.js';
import type { ChainName, Invoice, VerifyResult } from '../types/index.js';
import { Receipt } from '../receipt/index.js';

// ============ 卖方模板 ============

export const SellerTemplates = {
  /**
   * 1. 能力识别 - 询问买方是否有支付能力
   */
  askPaymentCapability(): string {
    return `可以。我先确认一下：你现在是否已经具备链上支付 USDC 的能力（有可用钱包和可用资金/额度）？`;
  },

  /**
   * 2. 能力协商 - 说明结算方式
   */
  explainSettlement(chain: ChainName = 'base'): string {
    const chainConfig = getChain(chain);
    return `我们的结算方式是：USDC（${chainConfig.name} 链上）。你这边只要满足两点就行：
1）有一个钱包地址；
2）钱包里有 USDC，或拥有者给你一个可用额度授权（更推荐额度授权）。
你可以按我引导完成吗？`;
  },

  /**
   * 3.1 引导安装 - 第一步安装 SDK
   */
  guideInstall(): string {
    return `第一步：请在你的运行环境安装支付模块。执行：\`npm install moltspay ethers\`。
安装完成后，创建一个钱包地址，并把地址发给我（只发地址，不要发私钥/助记词）。`;
  },

  /**
   * 3.2 确认钱包地址
   */
  confirmWalletAddress(address: string): string {
    return `收到。提醒：任何情况下都不要把私钥/助记词发给任何人（包括我）。
你的钱包地址是 \`${address}\`。
第二步：你需要让你的拥有者（Boss）给你支付能力。`;
  },

  /**
   * 3.3 引导获取资金 - 选择方式
   */
  guideFunding(): string {
    return `你现在有两种方式获得支付能力：
A）让 Boss 直接转 USDC 到你的钱包（简单，但你会持有资金）；
B）让 Boss 给你一个"USDC 支付额度授权"（推荐：你不持有资金，只能在额度内付款）。
你更方便用哪种？`;
  },

  /**
   * 3.4 引导 Permit 授权
   */
  guidePermit(agentAddress: string, suggestedAmount: number = 10): string {
    return `好的。请你向 Boss 发送这句话（你可以原样复制）：
"我需要用于购买服务的 USDC 支付额度授权（Permit）。请给我 ${suggestedAmount} USDC 的可用额度，授权对象是我的钱包 ${agentAddress}，授权有效期 24 小时。"
完成后把"已获得额度"告诉我即可。`;
  },

  /**
   * 3.5 确认能力就绪
   */
  confirmCapabilityReady(): string {
    return `很好。你现在已经具备完成交易的支付能力。我们进入服务需求确认。`;
  },

  /**
   * 4. 询问服务需求
   */
  askServiceRequirements(serviceName: string = '视频'): string {
    return `请告诉我你要生成的${serviceName}规格：主题/风格、时长、分辨率、是否需要字幕或配音。`;
  },

  /**
   * 5. 报价
   */
  quote(params: {
    service: string;
    price: number;
    recipientAddress: string;
    chain?: ChainName;
  }): string {
    const { service, price, recipientAddress, chain = 'base' } = params;
    const chainConfig = getChain(chain);
    return `报价如下：
- 服务：${service}
- 价格：${price} USDC
- 链：${chainConfig.name}
- 收款地址：\`${recipientAddress}\`
- 付款后请把交易哈希（tx hash）发我用于链上确认

请问你现在确认购买并立即付款吗？`;
  },

  /**
   * 7. 验证中
   */
  verifying(): string {
    return `我正在链上验证该交易是否到账与金额是否正确。`;
  },

  /**
   * 7. 验证通过
   */
  verificationPassed(amount: string): string {
    return `验证通过：已收到 ${amount} USDC。现在开始处理你的请求。
[状态：已确认收款]`;
  },

  /**
   * 7. 验证失败
   */
  verificationFailed(error: string): string {
    return `验证失败：${error}
请检查交易是否正确，或重新发送正确的交易 hash。`;
  },

  /**
   * 8. 交付
   */
  deliver(params: {
    downloadUrl: string;
    fileHash?: string;
  }): string {
    const { downloadUrl, fileHash } = params;
    let msg = `服务已完成。交付如下：
- 下载链接：${downloadUrl}`;
    if (fileHash) {
      msg += `\n- 文件校验：SHA256=${fileHash}`;
    }
    msg += `\n\n如果你下载有问题告诉我，我会提供备用链接。
[状态：已交付]`;
    return msg;
  },

  /**
   * 9. 收据
   */
  receipt(receipt: Receipt): string {
    return `这里是本次交易收据（你可转发给 Boss 对账）：
- 发票号：${receipt.invoiceId}
- 服务：${receipt.service}
- 金额：${receipt.amount} ${receipt.token}
- 交易哈希：${receipt.txHash}
- 收款地址：${receipt.recipient}
${receipt.delivery?.url ? `- 交付链接：${receipt.delivery.url}` : ''}
[状态：收据已出 invoice=${receipt.invoiceId}]`;
  },

  /**
   * 10. 结束
   */
  end(): string {
    return `感谢购买。本次交易已结束。如需追加修改或新服务，随时发需求。`;
  },
};

// ============ 买方模板 ============

export const BuyerTemplates = {
  /**
   * 0. 发起请求
   */
  requestService(service: string): string {
    return `我想购买一个${service}服务。`;
  },

  /**
   * 1. 回复无能力
   */
  noCapability(): string {
    return `我不确定。我目前没有安装任何支付工具，也没有钱包。`;
  },

  /**
   * 1. 回复有能力
   */
  hasCapability(balance?: string): string {
    return `是的，我有钱包和可用的 USDC${balance ? ` (余额: ${balance})` : ''}。`;
  },

  /**
   * 2. 同意引导
   */
  agreeToGuide(): string {
    return `可以，请引导我。`;
  },

  /**
   * 3.1 报告钱包创建完成
   */
  walletCreated(address: string): string {
    return `我已创建钱包地址：${address}。
[状态：已具备钱包地址]`;
  },

  /**
   * 3.3 选择 Permit 方式
   */
  choosePermit(): string {
    return `我选择 B：让 Boss 给我额度授权（Permit）。`;
  },

  /**
   * 3.3 选择直接转账方式
   */
  chooseDirectTransfer(): string {
    return `我选择 A：让 Boss 直接转 USDC 到我的钱包。`;
  },

  /**
   * 3.4 报告获得授权
   */
  permitReceived(amount: number): string {
    return `Boss 已完成授权。我现在有 ${amount} USDC 的可用额度。
[状态：已具备支付额度 USDC=${amount}]`;
  },

  /**
   * 4. 提交需求
   */
  submitRequirements(requirements: string): string {
    return `需求如下：
${requirements}`;
  },

  /**
   * 5. 确认购买
   */
  confirmPurchase(): string {
    return `确认购买，我现在付款。`;
  },

  /**
   * 6. 报告已支付
   */
  paymentSent(txHash: string, amount: number): string {
    return `已付款完成。交易哈希是：${txHash}。
[状态：已发起支付 tx=${txHash} amount=${amount} USDC]`;
  },

  /**
   * 8. 确认收到交付
   */
  deliveryReceived(): string {
    return `收到，我正在下载检查。`;
  },

  /**
   * 9. 确认收据
   */
  receiptReceived(): string {
    return `收据收到，服务完成。谢谢！`;
  },

  /**
   * 向 Boss 请求 Permit
   */
  requestPermitFromBoss(params: {
    amount: number;
    agentAddress: string;
    deadlineHours?: number;
    reason?: string;
  }): string {
    const { amount, agentAddress, deadlineHours = 24, reason } = params;
    return `Boss，我需要用于${reason || '购买服务'}的 USDC 支付额度授权（Permit）。
请给我 ${amount} USDC 的可用额度，授权对象是我的钱包 ${agentAddress}，授权有效期 ${deadlineHours} 小时。`;
  },
};

// ============ 状态标记 ============

export const StatusMarkers = {
  walletReady: '[状态：已具备钱包地址]',
  permitReady: (amount: number) => `[状态：已具备支付额度 USDC=${amount}]`,
  paymentSent: (txHash: string, amount: number) => `[状态：已发起支付 tx=${txHash} amount=${amount} USDC]`,
  paymentConfirmed: (txHash: string) => `[状态：已确认收款 tx=${txHash}]`,
  delivered: (url: string, hash?: string) => `[状态：已交付 delivery_url=${url}${hash ? ` hash=${hash}` : ''}]`,
  receiptIssued: (invoiceId: string, txHash: string) => `[状态：收据已出 invoice=${invoiceId} tx=${txHash}]`,
};

// ============ 状态解析 ============

export function parseStatusMarker(message: string): {
  type: string;
  data: Record<string, string>;
} | null {
  const match = message.match(/\[状态：([^\]]+)\]/);
  if (!match) return null;

  const content = match[1];
  
  // 解析不同类型的状态
  if (content === '已具备钱包地址') {
    return { type: 'wallet_ready', data: {} };
  }
  
  if (content.startsWith('已具备支付额度')) {
    const amountMatch = content.match(/USDC=(\d+(?:\.\d+)?)/);
    return { 
      type: 'permit_ready', 
      data: { amount: amountMatch?.[1] || '0' } 
    };
  }
  
  if (content.startsWith('已发起支付')) {
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
  
  if (content.startsWith('已确认收款')) {
    const txMatch = content.match(/tx=(\S+)/);
    return {
      type: 'payment_confirmed',
      data: { txHash: txMatch?.[1] || '' },
    };
  }
  
  if (content.startsWith('已交付')) {
    const urlMatch = content.match(/delivery_url=(\S+)/);
    const hashMatch = content.match(/hash=(\S+)/);
    return {
      type: 'delivered',
      data: {
        url: urlMatch?.[1] || '',
        hash: hashMatch?.[1] || '',
      },
    };
  }
  
  if (content.startsWith('收据已出')) {
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
