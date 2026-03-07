/**
 * On-chain Payment Verification Module
 */

import { ethers } from 'ethers';
import { getChain, getChainById, type ChainConfig, type ChainName, type TokenSymbol } from '../chains';

// ERC20 Transfer event signature
const TRANSFER_EVENT_TOPIC = ethers.id('Transfer(address,address,uint256)');

export interface VerifyPaymentParams {
  txHash: string;
  expectedAmount: number;
  expectedTo?: string;
  chain?: string | number;
  /** Expected token (if not specified, accepts both USDC and USDT) */
  expectedToken?: TokenSymbol;
}

export interface VerifyPaymentResult {
  verified: boolean;
  amount?: number;
  token?: TokenSymbol;
  from?: string;
  to?: string;
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

/**
 * Verify on-chain payment
 * Supports both USDC and USDT transfers
 */
export async function verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
  const { txHash, expectedAmount, expectedTo, expectedToken } = params;
  
  // Get chain config
  let chain: ChainConfig | undefined;
  try {
    if (typeof params.chain === 'number') {
      chain = getChainById(params.chain);
    } else {
      chain = getChain((params.chain || 'base') as ChainName);
    }
    if (!chain) {
      return { verified: false, error: `Unsupported chain: ${params.chain}` };
    }
  } catch (e) {
    return { verified: false, error: `Unsupported chain: ${params.chain}` };
  }

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    
    // Get transaction receipt
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt) {
      return { verified: false, error: 'Transaction not found or not confirmed' };
    }

    if (receipt.status !== 1) {
      return { verified: false, error: 'Transaction failed' };
    }

    // Build map of accepted token addresses
    const tokenAddresses: Record<string, TokenSymbol> = {};
    
    if (!expectedToken || expectedToken === 'USDC') {
      tokenAddresses[chain.tokens.USDC.address.toLowerCase()] = 'USDC';
    }
    if (!expectedToken || expectedToken === 'USDT') {
      tokenAddresses[chain.tokens.USDT.address.toLowerCase()] = 'USDT';
    }

    if (Object.keys(tokenAddresses).length === 0) {
      return { verified: false, error: `No token addresses configured for ${chain.name}` };
    }

    for (const log of receipt.logs) {
      const logAddress = log.address.toLowerCase();
      
      // Check if this is one of our accepted tokens
      const detectedToken = tokenAddresses[logAddress];
      if (!detectedToken) {
        continue;
      }

      // Check if Transfer event
      if (log.topics.length < 3 || log.topics[0] !== TRANSFER_EVENT_TOPIC) {
        continue;
      }

      // Parse Transfer event params
      const from = '0x' + log.topics[1].slice(-40);
      const to = '0x' + log.topics[2].slice(-40);
      const amountRaw = BigInt(log.data);
      const tokenConfig = chain.tokens[detectedToken];
      const amount = Number(amountRaw) / (10 ** tokenConfig.decimals);

      // Verify recipient address
      if (expectedTo && to.toLowerCase() !== expectedTo.toLowerCase()) {
        continue;
      }

      // Verify amount
      if (amount < expectedAmount) {
        return {
          verified: false,
          error: `Insufficient amount: received ${amount} ${detectedToken}, expected ${expectedAmount}`,
          amount,
          token: detectedToken,
          from,
          to,
          txHash,
          blockNumber: receipt.blockNumber,
        };
      }

      // Verification successful
      return {
        verified: true,
        amount,
        token: detectedToken,
        from,
        to,
        txHash,
        blockNumber: receipt.blockNumber,
      };
    }

    const tokenList = expectedToken ? expectedToken : 'USDC/USDT';
    return { verified: false, error: `No ${tokenList} transfer found` };

  } catch (e: any) {
    return { verified: false, error: e.message || String(e) };
  }
}

/**
 * Get transaction status
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
      // Check if in pending pool
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
 * Wait for transaction confirmation
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
      return { verified: false, confirmed: false, error: `Unsupported chain: ${chain}` };
    }
  } catch (e) {
    return { verified: false, confirmed: false, error: `Unsupported chain: ${chain}` };
  }

  const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
  
  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations, timeoutMs);
    
    if (!receipt) {
      return { verified: false, confirmed: false, error: 'Timeout waiting' };
    }

    if (receipt.status !== 1) {
      return { verified: false, confirmed: true, error: 'Transaction failed' };
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
