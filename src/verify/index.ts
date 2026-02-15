/**
 * 链上支付验证模块
 */

import { ethers } from 'ethers';
import { getChain, getChainById, type ChainConfig, type ChainName } from '../chains';

// ERC20 Transfer 事件签名
const TRANSFER_EVENT_TOPIC = ethers.id('Transfer(address,address,uint256)');

export interface VerifyPaymentParams {
  txHash: string;
  expectedAmount: number;
  expectedTo?: string;
  chain?: string | number;
}

export interface VerifyPaymentResult {
  verified: boolean;
  amount?: number;
  from?: string;
  to?: string;
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

/**
 * 验证链上支付
 */
export async function verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
  const { txHash, expectedAmount, expectedTo } = params;
  
  // 获取链配置
  let chain: ChainConfig | undefined;
  try {
    if (typeof params.chain === 'number') {
      chain = getChainById(params.chain);
    } else {
      chain = getChain((params.chain || 'base') as ChainName);
    }
    if (!chain) {
      return { verified: false, error: `不支持的链: ${params.chain}` };
    }
  } catch (e) {
    return { verified: false, error: `不支持的链: ${params.chain}` };
  }

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    
    // 获取交易回执
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt) {
      return { verified: false, error: '交易未找到或未确认' };
    }

    if (receipt.status !== 1) {
      return { verified: false, error: '交易失败' };
    }

    // 解析 Transfer 事件
    const usdcAddress = chain.usdc?.toLowerCase();
    if (!usdcAddress) {
      return { verified: false, error: `链 ${chain.name} 未配置USDC地址` };
    }

    for (const log of receipt.logs) {
      // 检查是否是 USDC 合约
      if (log.address.toLowerCase() !== usdcAddress) {
        continue;
      }

      // 检查是否是 Transfer 事件
      if (log.topics.length < 3 || log.topics[0] !== TRANSFER_EVENT_TOPIC) {
        continue;
      }

      // 解析 Transfer 事件参数
      const from = '0x' + log.topics[1].slice(-40);
      const to = '0x' + log.topics[2].slice(-40);
      const amountRaw = BigInt(log.data);
      const amount = Number(amountRaw) / 1e6; // USDC 6位小数

      // 验证收款地址
      if (expectedTo && to.toLowerCase() !== expectedTo.toLowerCase()) {
        continue;
      }

      // 验证金额
      if (amount < expectedAmount) {
        return {
          verified: false,
          error: `金额不足: 收到 ${amount} USDC, 需要 ${expectedAmount} USDC`,
          amount,
          from,
          to,
          txHash,
          blockNumber: receipt.blockNumber,
        };
      }

      // 验证成功
      return {
        verified: true,
        amount,
        from,
        to,
        txHash,
        blockNumber: receipt.blockNumber,
      };
    }

    return { verified: false, error: '未找到USDC转账记录' };

  } catch (e: any) {
    return { verified: false, error: e.message || String(e) };
  }
}

/**
 * 获取交易状态
 */
export async function getTransactionStatus(
  txHash: string,
  chain: string | number = 'base'
): Promise<{
  status: 'pending' | 'confirmed' | 'failed' | 'not_found';
  blockNumber?: number;
  confirmations?: number;
}> {
  let chainConfig: ChainConfig | undefined;
  try {
    chainConfig = typeof chain === 'number' ? getChainById(chain) : getChain(chain as ChainName);
    if (!chainConfig) return { status: 'not_found' };
  } catch {
    return { status: 'not_found' };
  }

  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      // 检查是否在 pending 池中
      const tx = await provider.getTransaction(txHash);
      if (tx) {
        return { status: 'pending' };
      }
      return { status: 'not_found' };
    }

    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - receipt.blockNumber;

    if (receipt.status === 1) {
      return {
        status: 'confirmed',
        blockNumber: receipt.blockNumber,
        confirmations,
      };
    } else {
      return {
        status: 'failed',
        blockNumber: receipt.blockNumber,
      };
    }
  } catch {
    return { status: 'not_found' };
  }
}

/**
 * 等待交易确认
 */
export async function waitForTransaction(
  txHash: string,
  chain: string | number = 'base',
  confirmations = 1,
  timeoutMs = 60000
): Promise<VerifyPaymentResult & { confirmed: boolean }> {
  let chainConfig: ChainConfig | undefined;
  try {
    chainConfig = typeof chain === 'number' ? getChainById(chain) : getChain(chain as ChainName);
    if (!chainConfig) {
      return { verified: false, confirmed: false, error: `不支持的链: ${chain}` };
    }
  } catch (e) {
    return { verified: false, confirmed: false, error: `不支持的链: ${chain}` };
  }

  const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
  
  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations, timeoutMs);
    
    if (!receipt) {
      return { verified: false, confirmed: false, error: '等待超时' };
    }

    if (receipt.status !== 1) {
      return { verified: false, confirmed: true, error: '交易失败' };
    }

    return {
      verified: true,
      confirmed: true,
      txHash,
      blockNumber: receipt.blockNumber,
    };
  } catch (e: any) {
    return { verified: false, confirmed: false, error: e.message || String(e) };
  }
}
