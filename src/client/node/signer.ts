/**
 * NodeSigner — PaymentSigner implementation for Node.js.
 *
 * Wraps:
 *   - an ethers.Wallet for EVM signTypedData + sendEvmTransaction
 *   - an optional (lazy-loaded) @solana/web3.js Keypair for signSolanaTransaction
 *
 * The Node CLI's `MoltsPayClient` constructs this from the local wallet files
 * in `~/.moltspay/`. Public surface is the same `PaymentSigner` interface that
 * Web signers implement (Phase 4), so `MoltsPayClient.pay()` doesn't branch on
 * runtime.
 */

import { ethers, Wallet } from 'ethers';
import { Transaction, Keypair } from '@solana/web3.js';
import type { PaymentSigner } from '../signer.js';
import type { TypedDataEnvelope } from '../core/index.js';
import { CHAINS } from '../../chains/index.js';

export interface NodeSignerOptions {
  /** Lazy loader for the Solana Keypair. Resolves to null when no Solana wallet is configured. */
  getSolanaKeypair?: () => Keypair | null;
}

export class NodeSigner implements PaymentSigner {
  private readonly evmWallet: Wallet;
  private readonly getSolanaKeypair: () => Keypair | null;

  constructor(evmWallet: Wallet, options: NodeSignerOptions = {}) {
    this.evmWallet = evmWallet;
    this.getSolanaKeypair = options.getSolanaKeypair ?? (() => null);
  }

  async getEvmAddress(): Promise<string> {
    return this.evmWallet.address;
  }

  async getSolanaAddress(): Promise<string | null> {
    const kp = this.getSolanaKeypair();
    return kp ? kp.publicKey.toBase58() : null;
  }

  async signTypedData<TMessage>(envelope: TypedDataEnvelope<TMessage>): Promise<string> {
    // ethers expects types without the implicit EIP712Domain entry (our envelopes
    // already exclude it) and mutable arrays; core stores them `readonly`, so we
    // shallow-copy each type-list to satisfy the ethers signature.
    const mutableTypes: Record<string, { name: string; type: string }[]> = {};
    for (const [key, fields] of Object.entries(envelope.types)) {
      mutableTypes[key] = [...fields];
    }
    return this.evmWallet.signTypedData(
      envelope.domain,
      mutableTypes,
      envelope.message as Record<string, unknown>
    );
  }

  async sendEvmTransaction(args: {
    chainId: number;
    to: string;
    data: string;
    value?: string;
  }): Promise<string> {
    const chain = findChainByChainId(args.chainId);
    if (!chain) {
      throw new Error(`sendEvmTransaction: unknown chainId ${args.chainId}`);
    }
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const connected = this.evmWallet.connect(provider);
    const tx = await connected.sendTransaction({
      to: args.to,
      data: args.data,
      value: args.value ? BigInt(args.value) : 0n,
    });
    return tx.hash;
  }

  async signSolanaTransaction(args: {
    transactionBase64: string;
    partialSign: boolean;
  }): Promise<string> {
    const kp = this.getSolanaKeypair();
    if (!kp) {
      throw new Error('signSolanaTransaction: no Solana wallet configured');
    }
    const tx = Transaction.from(Buffer.from(args.transactionBase64, 'base64'));
    if (args.partialSign) {
      tx.partialSign(kp);
    } else {
      tx.sign(kp);
    }
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }
}

// CHAINS is a Record<ChainName, ChainConfig>; we look up by numeric chainId.
function findChainByChainId(chainId: number): { rpc: string } | undefined {
  for (const cfg of Object.values(CHAINS)) {
    if ((cfg as { chainId?: number }).chainId === chainId) {
      return cfg as { rpc: string };
    }
  }
  return undefined;
}
