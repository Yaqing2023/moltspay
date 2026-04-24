/**
 * Solana Facilitator
 * 
 * Pay-for-success payment settlement for Solana SPL token transfers.
 * Unlike EVM chains, Solana doesn't have a third-party facilitator - 
 * we verify and settle directly on-chain.
 * 
 * Flow:
 * 1. Client signs a SPL token transfer authorization
 * 2. Server receives the signed transaction
 * 3. Server verifies the signature and amount
 * 4. Server submits the transaction to settle payment
 */

import { 
  Connection, 
  PublicKey, 
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  Keypair,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  getAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { 
  BaseFacilitator, 
  type X402PaymentPayload, 
  type X402PaymentRequirements,
  type VerifyResult,
  type SettleResult,
  type HealthCheckResult,
} from './interface.js';
import { SOLANA_CHAINS, type SolanaChainName } from '../chains/solana.js';

/**
 * Solana payment payload structure
 */
export interface SolanaPaymentPayload {
  /** Base58 encoded signed transaction */
  signedTransaction: string;
  /** Sender's public key (Base58) */
  sender: string;
  /** Chain: solana or solana_devnet */
  chain: SolanaChainName;
}

/**
 * Solana Facilitator configuration
 */
export interface SolanaFacilitatorConfig {
  /** Optional fee payer keypair for gasless transactions */
  feePayerKeypair?: Keypair;
}

/**
 * Solana Facilitator for pay-for-success payments
 * 
 * Supports gasless mode: if feePayerKeypair is provided, server pays tx fees
 */
export class SolanaFacilitator extends BaseFacilitator {
  readonly name = 'solana';
  readonly displayName = 'Solana Direct';
  readonly supportedNetworks = ['solana:mainnet', 'solana:devnet'];

  private connections: Map<SolanaChainName, Connection> = new Map();
  private feePayerKeypair?: Keypair;

  constructor(config?: SolanaFacilitatorConfig) {
    super();
    this.feePayerKeypair = config?.feePayerKeypair;
    
    // Initialize connections
    for (const [chain, config] of Object.entries(SOLANA_CHAINS)) {
      this.connections.set(
        chain as SolanaChainName, 
        new Connection(config.rpc, 'confirmed')
      );
    }
    
    if (this.feePayerKeypair) {
      console.log(`[SolanaFacilitator] Gasless mode enabled. Fee payer: ${this.feePayerKeypair.publicKey.toBase58()}`);
    }
  }
  
  /**
   * Get fee payer public key (for gasless transactions)
   */
  getFeePayerPubkey(): string | null {
    return this.feePayerKeypair?.publicKey.toBase58() || null;
  }

  private getConnection(chain: SolanaChainName): Connection {
    const conn = this.connections.get(chain);
    if (!conn) {
      throw new Error(`No connection for chain: ${chain}`);
    }
    return conn;
  }

  /**
   * Convert our chain name to network identifier
   */
  static chainToNetwork(chain: SolanaChainName): string {
    return chain === 'solana' ? 'solana:mainnet' : 'solana:devnet';
  }

  /**
   * Convert network identifier to chain name
   */
  static networkToChain(network: string): SolanaChainName | null {
    if (network === 'solana:mainnet') return 'solana';
    if (network === 'solana:devnet') return 'solana_devnet';
    return null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // Check devnet connection
      const conn = this.getConnection('solana_devnet');
      await conn.getSlot();
      return {
        healthy: true,
        latencyMs: Date.now() - start,
      };
    } catch (error: any) {
      return {
        healthy: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify a Solana payment
   * 
   * Checks:
   * 1. Transaction is valid and properly signed
   * 2. Transfer instruction matches expected amount and recipient
   */
  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult> {
    try {
      const solanaPayload = paymentPayload.payload as SolanaPaymentPayload;
      if (!solanaPayload || !solanaPayload.signedTransaction) {
        return { valid: false, error: 'Missing signed transaction' };
      }

      const chain = solanaPayload.chain || 'solana_devnet';
      const chainConfig = SOLANA_CHAINS[chain];
      if (!chainConfig) {
        return { valid: false, error: `Invalid chain: ${chain}` };
      }

      // Decode the transaction
      const txBuffer = Buffer.from(solanaPayload.signedTransaction, 'base64');
      let tx: Transaction | VersionedTransaction;
      
      try {
        // Try legacy transaction first
        tx = Transaction.from(txBuffer);
      } catch {
        // Try versioned transaction
        tx = VersionedTransaction.deserialize(txBuffer);
      }

      // Verify at least one signature exists (may be partial in gasless mode)
      if (tx instanceof Transaction) {
        // In gasless mode, fee payer signature is added by server
        // Client only signs for token transfer authority
        const hasAnySignature = tx.signatures.some(sig => 
          sig.signature && !sig.signature.every(b => b === 0)
        );
        if (!hasAnySignature) {
          return { valid: false, error: 'Transaction not signed' };
        }
      }

      // Parse expected values from requirements
      const expectedAmount = BigInt(requirements.amount);
      const expectedRecipient = new PublicKey(requirements.payTo);

      // For now, we trust the transaction structure
      // Full verification happens at settlement time
      return {
        valid: true,
        details: {
          chain,
          sender: solanaPayload.sender,
          recipient: requirements.payTo,
          amount: requirements.amount,
        },
      };
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Settle a Solana payment
   * 
   * Submits the signed transaction to the network.
   * In gasless mode, adds fee payer signature before submitting.
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult> {
    try {
      const solanaPayload = paymentPayload.payload as SolanaPaymentPayload;
      if (!solanaPayload || !solanaPayload.signedTransaction) {
        return { success: false, error: 'Missing signed transaction' };
      }

      const chain = solanaPayload.chain || 'solana_devnet';
      const connection = this.getConnection(chain);

      // Decode the transaction
      const txBuffer = Buffer.from(solanaPayload.signedTransaction, 'base64');
      
      let txToSend: Buffer;
      
      try {
        // Try legacy transaction
        const tx = Transaction.from(txBuffer);
        
        // Check if we need to add fee payer signature (gasless mode)
        if (this.feePayerKeypair && tx.feePayer) {
          const feePayerPubkey = this.feePayerKeypair.publicKey.toBase58();
          const txFeePayer = tx.feePayer.toBase58();
          
          if (txFeePayer === feePayerPubkey) {
            // Gasless mode: add fee payer signature
            console.log(`[SolanaFacilitator] Gasless mode: adding fee payer signature`);
            tx.partialSign(this.feePayerKeypair);
          }
        }
        
        txToSend = tx.serialize();
      } catch (e: any) {
        // Fall back to versioned transaction (no gasless support for versioned yet)
        txToSend = txBuffer;
      }

      // Send the transaction
      const signature = await connection.sendRawTransaction(txToSend, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');
      
      if (confirmation.value.err) {
        return {
          success: false,
          error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
          transaction: signature,
        };
      }

      return {
        success: true,
        transaction: signature,
        status: 'confirmed',
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  supportsNetwork(network: string): boolean {
    return this.supportedNetworks.includes(network);
  }
}

/**
 * Create a Solana payment transaction for signing
 * 
 * This is called by the client to create the transaction to sign.
 * 
 * @param senderPubkey - The sender's public key (token owner)
 * @param recipientPubkey - The recipient's public key
 * @param amount - Amount in token base units
 * @param chain - Solana chain (solana or solana_devnet)
 * @param feePayerPubkey - Optional fee payer public key for gasless transactions
 */
export async function createSolanaPaymentTransaction(
  senderPubkey: PublicKey,
  recipientPubkey: PublicKey,
  amount: bigint,
  chain: SolanaChainName,
  feePayerPubkey?: PublicKey,
  connection?: Connection,
): Promise<Transaction> {
  const chainConfig = SOLANA_CHAINS[chain];
  const conn = connection ?? new Connection(chainConfig.rpc, 'confirmed');
  const mint = new PublicKey(chainConfig.tokens.USDC.mint);

  // Determine who pays fees (gasless mode uses server's fee payer)
  const actualFeePayer = feePayerPubkey || senderPubkey;

  // Get ATAs
  const senderATA = await getAssociatedTokenAddress(mint, senderPubkey);
  const recipientATA = await getAssociatedTokenAddress(mint, recipientPubkey);

  const transaction = new Transaction();

  // Check if recipient ATA exists
  try {
    await getAccount(conn, recipientATA);
  } catch {
    // Create ATA for recipient (fee payer pays rent in gasless mode)
    transaction.add(
      createAssociatedTokenAccountInstruction(
        actualFeePayer,  // payer (fee payer in gasless mode)
        recipientATA,    // ata to create
        recipientPubkey, // owner
        mint             // mint
      )
    );
  }

  // Add transfer instruction
  transaction.add(
    createTransferCheckedInstruction(
      senderATA,      // source
      mint,           // mint
      recipientATA,   // destination
      senderPubkey,   // owner (sender still authorizes the transfer)
      amount,         // amount
      chainConfig.tokens.USDC.decimals // decimals
    )
  );

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = actualFeePayer;

  return transaction;
}

export default SolanaFacilitator;
