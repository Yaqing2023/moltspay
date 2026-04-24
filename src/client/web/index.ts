/**
 * MoltsPay Web Client
 *
 * Browser-native companion to `MoltsPayClient` (Node). The two share one
 * protocol core (`src/client/core/`) — every x402 detail, typed-data builder,
 * and chain mapping is identical. The Web Client differs only in that:
 *
 *   - It never reads or writes a wallet file. All signing is delegated to an
 *     injected `PaymentSigner` (an EIP-1193 / wallet-adapter shim the app owns).
 *   - It always posts to `/execute` and consumes `X-Payment-Required`. It
 *     never negotiates MPP over `WWW-Authenticate` — Tempo is reached via the
 *     EIP-2612 permit branch instead. See docs/WEB-CLIENT-DESIGN.md §Tempo.
 *   - Spending limits are opt-in and backed by `localStorage` when enabled.
 */

import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_HEADER,
  parsePaymentRequiredHeader,
  serverAcceptedChains,
  selectChain,
  findRequirementForChain,
  buildEIP3009TypedData,
  buildEIP2612PermitTypedData,
  buildBnbIntentTypedData,
  chainNameToNetwork,
  encodePaymentHeader,
  buildPaymentPayload,
  uint8ArrayToBase64,
  NotInitializedError,
  NeedsApprovalError,
  UnsupportedChainError,
  ServerError,
  InsufficientBalanceError,
  type X402PaymentRequirements,
  type ChainName as CoreChainName,
} from '../core/index.js';
import { createSolanaPaymentTransaction } from '../../facilitators/solana.js';
import { CHAINS, type EvmChainName } from '../../chains/index.js';
import { SOLANA_CHAINS, type SolanaChainName } from '../../chains/solana.js';
import type { PaymentSigner } from '../signer.js';
import type { ServicesResponse } from '../types.js';
import { SpendingLedger, type SpendingLimitsConfig } from './storage.js';

export { eip1193Signer } from './signers/eip1193.js';
export type { Eip1193Provider, Eip1193ChainMetadata, Eip1193SignerOptions } from './signers/eip1193.js';
export { solanaSigner } from './signers/solana-adapter.js';
export type { SolanaSignerAdapter } from './signers/solana-adapter.js';
export { composeSigners } from './signers/compose.js';
export { SpendingLedger } from './storage.js';
export type { SpendingLimitsConfig } from './storage.js';
export type { PaymentSigner } from '../signer.js';
export type { CoreChainName as ChainName };
export {
  NeedsApprovalError,
  UnsupportedChainError,
  PaymentRejectedError,
  InsufficientBalanceError,
  SpendingLimitExceededError,
  ServerError,
  MoltsPayError,
} from '../core/index.js';

export interface MoltsPayWebClientOptions {
  /** PaymentSigner to authorize every payment. Typically `eip1193Signer(window.ethereum)` or `composeSigners(...)`. */
  signer: PaymentSigner;

  /** Default chain for `pay()` when the server accepts multiple and the caller omits `options.chain`. */
  defaultChain?: CoreChainName;

  /** Enable `localStorage`-backed spending limits. Off by default. */
  spendingLimits?: SpendingLimitsConfig;

  /** Optional fetch override — useful for MSW tests or proxying. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;

  /**
   * Per-chain Solana RPC URL override. Required on mainnet in practice —
   * the public `api.mainnet-beta.solana.com` endpoint returns 403 to browser
   * requests. Point at Helius / QuickNode / Alchemy etc. Falls back to
   * `SOLANA_CHAINS[chain].rpc` when omitted.
   */
  solanaRpc?: {
    solana?: string;
    solana_devnet?: string;
  };
}

export interface WebPayOptions {
  /** Chain to pay on. Required when the server accepts more than one. */
  chain?: CoreChainName;
  /** Send user params at top level (`{ service, ...params }`) instead of wrapped (`{ service, params }`). */
  rawData?: boolean;
}

type ResolvedFetch = typeof fetch;

export class MoltsPayWebClient {
  private readonly signer: PaymentSigner;
  private readonly defaultChain?: CoreChainName;
  private readonly ledger: SpendingLedger | null;
  private readonly fetchImpl: ResolvedFetch;
  private readonly solanaRpc?: { solana?: string; solana_devnet?: string };

  constructor(options: MoltsPayWebClientOptions) {
    if (!options.signer) {
      throw new NotInitializedError('MoltsPayWebClient: signer is required');
    }
    this.signer = options.signer;
    this.defaultChain = options.defaultChain;
    this.ledger = options.spendingLimits ? new SpendingLedger(options.spendingLimits) : null;
    this.fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.solanaRpc = options.solanaRpc;
  }

  private getSolanaConnection(chain: SolanaChainName): Connection {
    const rpc = this.solanaRpc?.[chain] ?? SOLANA_CHAINS[chain].rpc;
    return new Connection(rpc, 'confirmed');
  }

  /** Fetch a provider's service manifest. Mirrors `MoltsPayClient.getServices`. */
  async getServices(serverUrl: string): Promise<ServicesResponse> {
    const normalizedUrl = serverUrl.replace(/\/(services|api\/services|registry\/services)\/?$/, '');
    const endpoints = ['/services', '/api/services', '/registry/services'];
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchImpl(`${normalizedUrl}${endpoint}`);
        if (!res.ok) continue;
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) continue;
        return (await res.json()) as ServicesResponse;
      } catch {
        continue;
      }
    }
    throw new ServerError(0, `Failed to get services: no valid endpoint found at ${normalizedUrl}`);
  }

  /**
   * Pay for a service via x402. Returns the service `result` field (or the
   * whole JSON body if the server doesn't wrap). Throws `NeedsApprovalError`
   * for BNB when allowance is insufficient — call {@link approveBnb} and retry.
   */
  async pay(
    serverUrl: string,
    service: string,
    params: Record<string, unknown>,
    options: WebPayOptions = {}
  ): Promise<Record<string, unknown>> {
    const executeUrl = await this.resolveExecuteUrl(serverUrl, service);
    const requestBody = this.buildRequestBody(service, params, options);

    const initialRes = await this.fetchImpl(executeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    // Happy path: server did not charge — return result directly.
    if (initialRes.status !== 402) {
      const data = (await initialRes.json()) as { result?: Record<string, unknown>; error?: string };
      if (initialRes.ok && data.result) {
        return data.result;
      }
      if (initialRes.ok) {
        return data as Record<string, unknown>;
      }
      throw new ServerError(initialRes.status, data.error ?? 'Unexpected response');
    }

    // Web Client consumes only X-Payment-Required. `WWW-Authenticate` (MPP) is
    // intentionally ignored — the server's `/execute` route does not emit it,
    // and Tempo reaches us through the x402 + permit path instead.
    const paymentRequiredHeader = initialRes.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!paymentRequiredHeader) {
      throw new ServerError(402, 'Missing X-Payment-Required header in 402 response');
    }

    const requirements = parsePaymentRequiredHeader(paymentRequiredHeader);
    const chain = this.chooseChain(requirements, options.chain);
    const req = findRequirementForChain(requirements, chain);
    if (!req) {
      throw new UnsupportedChainError(chain, `No payment requirement for chain '${chain}' in server response`);
    }

    if (chain === 'solana' || chain === 'solana_devnet') {
      return this.paySolana(executeUrl, service, params, req, chain, options);
    }
    if (chain === 'tempo_moderato') {
      return this.payTempoPermit(executeUrl, service, params, req, options);
    }
    if (chain === 'bnb' || chain === 'bnb_testnet') {
      return this.payBnb(executeUrl, service, params, req, chain, options);
    }
    return this.payEIP3009(executeUrl, service, params, req, chain, options);
  }

  /** Read-only balance check on the specified chain (or `defaultChain` if configured). */
  async getBalance(chain?: CoreChainName): Promise<{ usdc: number; usdt?: number; native: number }> {
    const target = chain ?? this.defaultChain;
    if (!target) {
      throw new UnsupportedChainError('unspecified', 'No chain provided and no defaultChain configured');
    }
    if (target === 'solana' || target === 'solana_devnet') {
      const conn = this.getSolanaConnection(target);
      const owner = await this.signer.getSolanaAddress?.();
      if (!owner) {
        throw new NotInitializedError('No Solana address available from signer');
      }
      const native = await conn.getBalance(new PublicKey(owner));
      return { usdc: 0, native: native / 1e9 };
    }

    const evmChain = CHAINS[target as EvmChainName];
    const provider = new ethers.JsonRpcProvider(evmChain.rpc);
    const owner = await this.signer.getEvmAddress();
    const tokenAbi = ['function balanceOf(address) view returns (uint256)'];

    const [nativeBalance, usdcBalance, usdtBalance] = await Promise.all([
      provider.getBalance(owner),
      new ethers.Contract(evmChain.tokens.USDC.address, tokenAbi, provider).balanceOf(owner),
      new ethers.Contract(evmChain.tokens.USDT.address, tokenAbi, provider).balanceOf(owner),
    ]);

    return {
      usdc: parseFloat(ethers.formatUnits(usdcBalance, evmChain.tokens.USDC.decimals)),
      usdt: parseFloat(ethers.formatUnits(usdtBalance, evmChain.tokens.USDT.decimals)),
      native: parseFloat(ethers.formatEther(nativeBalance)),
    };
  }

  /**
   * Approve a spender for the BNB chain's USDC / USDT (one-time, costs BNB gas).
   * The spender address is what the server advertised as `bnbSpender` in the
   * 402 response. Amount defaults to `MaxUint256` so only one approval is ever
   * needed per (chain, token, spender) tuple.
   */
  async approveBnb(args: {
    chain: 'bnb' | 'bnb_testnet';
    spender: string;
    token: 'USDC' | 'USDT';
    amount?: string;
  }): Promise<string> {
    if (!this.signer.sendEvmTransaction) {
      throw new NotInitializedError('Signer does not support sendEvmTransaction');
    }
    const chain = CHAINS[args.chain];
    const tokenAddr = chain.tokens[args.token].address;
    const amount = args.amount ?? ethers.MaxUint256.toString();

    const iface = new ethers.Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
    ]);
    const data = iface.encodeFunctionData('approve', [args.spender, amount]);

    return this.signer.sendEvmTransaction({
      chainId: chain.chainId,
      to: tokenAddr,
      data,
    });
  }

  // ===== internals =====

  private async resolveExecuteUrl(serverUrl: string, service: string): Promise<string> {
    try {
      const services = await this.getServices(serverUrl);
      const svc = services.services?.find((s) => s.id === service);
      if (svc?.endpoint) {
        return `${serverUrl}${svc.endpoint}`;
      }
    } catch {
      // Service discovery failure is non-fatal — we fall back to /execute.
    }
    return `${serverUrl}/execute`;
  }

  private buildRequestBody(
    service: string,
    params: Record<string, unknown>,
    options: WebPayOptions
  ): Record<string, unknown> {
    const body: Record<string, unknown> = options.rawData
      ? { service, ...params }
      : { service, params };
    if (options.chain) body.chain = options.chain;
    return body;
  }

  private chooseChain(
    requirements: X402PaymentRequirements[],
    userChain?: CoreChainName
  ): CoreChainName {
    const preferred = userChain ?? this.defaultChain;
    if (preferred) {
      return selectChain(requirements, preferred);
    }
    // Mirror 1.5.x behavior: only default to `base` when it's the sole option.
    const accepted = serverAcceptedChains(requirements);
    if (accepted.length === 1) {
      return accepted[0];
    }
    return selectChain(requirements); // throws with a helpful list of accepted chains
  }

  /**
   * Submit the x402 payload and return the service result. Shared by all
   * scheme branches — the only thing they vary is how they build `payload`.
   */
  private async submitPayment(
    executeUrl: string,
    service: string,
    params: Record<string, unknown>,
    options: WebPayOptions,
    paymentHeader: string,
    chainForBody: CoreChainName,
    charge: number
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = options.rawData
      ? { service, ...params, chain: chainForBody }
      : { service, params, chain: chainForBody };

    const paidRes = await this.fetchImpl(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PAYMENT_HEADER]: paymentHeader,
      },
      body: JSON.stringify(body),
    });

    const result = (await paidRes.json()) as { result?: Record<string, unknown>; error?: string };
    if (!paidRes.ok) {
      throw new ServerError(paidRes.status, result.error ?? 'Payment failed');
    }
    if (this.ledger && charge > 0) {
      this.ledger.record(charge);
    }
    return (result.result ?? (result as Record<string, unknown>));
  }

  // ----- EIP-3009 (Base / Polygon / Base Sepolia) -----

  private async payEIP3009(
    executeUrl: string,
    service: string,
    params: Record<string, unknown>,
    req: X402PaymentRequirements,
    chainName: CoreChainName,
    options: WebPayOptions
  ): Promise<Record<string, unknown>> {
    const evmChain = CHAINS[chainName as EvmChainName];
    const amountRaw = req.amount ?? req.maxAmountRequired;
    if (!amountRaw) {
      throw new ServerError(402, 'Missing amount in payment requirements');
    }
    const amountDisplay = Number(amountRaw) / 1e6;
    this.ledger?.check(amountDisplay);

    const payTo = req.payTo ?? req.resource;
    if (!payTo) {
      throw new ServerError(402, 'Missing payTo in payment requirements');
    }

    const owner = await this.signer.getEvmAddress();
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Use server's domain info when provided; otherwise fall back to our local
    // token config. This is the same precedence the Node client uses.
    const extra = (req.extra ?? {}) as { name?: string; version?: string };
    const tokenConfig = evmChain.tokens.USDC; // Web Client defaults to USDC for v1.6.0.
    const tokenName = extra.name ?? tokenConfig.eip712Name ?? 'USD Coin';
    const tokenVersion = extra.version ?? '2';

    const envelope = buildEIP3009TypedData({
      from: owner,
      to: payTo,
      value: amountRaw,
      nonce,
      chainId: evmChain.chainId,
      tokenAddress: req.asset ?? tokenConfig.address,
      tokenName,
      tokenVersion,
    });

    const signature = await this.signer.signTypedData(envelope);

    const payload = buildPaymentPayload({
      scheme: 'exact',
      network: chainNameToNetwork(chainName),
      payload: { authorization: envelope.message, signature },
      accepted: {
        scheme: 'exact',
        network: chainNameToNetwork(chainName),
        asset: req.asset ?? tokenConfig.address,
        amount: amountRaw,
        payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? 300,
        extra: { name: tokenName, version: tokenVersion },
      },
    });

    const header = encodePaymentHeader(payload);
    return this.submitPayment(executeUrl, service, params, options, header, chainName, amountDisplay);
  }

  // ----- EIP-2612 permit (Tempo Moderato) -----

  private async payTempoPermit(
    executeUrl: string,
    service: string,
    params: Record<string, unknown>,
    req: X402PaymentRequirements,
    options: WebPayOptions
  ): Promise<Record<string, unknown>> {
    const amountRaw = req.amount ?? req.maxAmountRequired;
    if (!amountRaw) {
      throw new ServerError(402, 'Missing amount in Tempo requirements');
    }
    const amountDisplay = Number(amountRaw) / 1e6;
    this.ledger?.check(amountDisplay);

    const extra = (req.extra ?? {}) as { tempoSpender?: string; name?: string; version?: string };
    const spender = extra.tempoSpender;
    if (!spender) {
      throw new ServerError(
        402,
        'Tempo requirement missing extra.tempoSpender — server has no settler configured (TEMPO_SETTLER_KEY)'
      );
    }
    if (!req.asset) {
      throw new ServerError(402, 'Tempo requirement missing asset (token address)');
    }
    if (!extra.name || !extra.version) {
      throw new ServerError(402, 'Tempo requirement missing extra.name / extra.version for EIP-712 domain');
    }

    const owner = await this.signer.getEvmAddress();

    // Fetch nonces(owner) from Tempo RPC. Read-only — no signer needed here.
    const tempoRpc = CHAINS.tempo_moderato.rpc;
    const provider = new ethers.JsonRpcProvider(tempoRpc);
    const token = new ethers.Contract(
      req.asset,
      ['function nonces(address owner) view returns (uint256)'],
      provider
    );
    const nonce = (await token.nonces(owner)) as bigint;
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const envelope = buildEIP2612PermitTypedData({
      owner,
      spender,
      value: amountRaw,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      chainId: CHAINS.tempo_moderato.chainId,
      tokenAddress: req.asset,
      tokenName: extra.name,
      tokenVersion: extra.version,
    });

    const rawSig = await this.signer.signTypedData(envelope);
    const split = ethers.Signature.from(rawSig);

    const payload = buildPaymentPayload({
      scheme: 'permit',
      network: chainNameToNetwork('tempo_moderato'),
      payload: {
        permit: {
          owner,
          spender,
          value: amountRaw,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          v: split.v,
          r: split.r,
          s: split.s,
        },
      },
      accepted: {
        scheme: 'permit',
        network: chainNameToNetwork('tempo_moderato'),
        asset: req.asset,
        amount: amountRaw,
        payTo: req.payTo ?? '',
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? 300,
        extra: { name: extra.name, version: extra.version, tempoSpender: spender },
      },
    });

    const header = encodePaymentHeader(payload);
    return this.submitPayment(executeUrl, service, params, options, header, 'tempo_moderato', amountDisplay);
  }

  // ----- BNB intent (BNB / BNB Testnet) -----

  private async payBnb(
    executeUrl: string,
    service: string,
    params: Record<string, unknown>,
    req: X402PaymentRequirements,
    chainName: 'bnb' | 'bnb_testnet',
    options: WebPayOptions
  ): Promise<Record<string, unknown>> {
    const evmChain = CHAINS[chainName];
    const extra = (req.extra ?? {}) as { bnbSpender?: string };
    const spender = extra.bnbSpender;
    if (!spender) {
      throw new ServerError(402, 'BNB requirement missing extra.bnbSpender');
    }
    if (!req.amount || !req.payTo) {
      throw new ServerError(402, 'BNB requirement missing amount or payTo');
    }

    const owner = await this.signer.getEvmAddress();
    const tokenConfig = evmChain.tokens.USDC; // Web Client v1.6.0 defaults to USDC on BNB.
    const tokenAddress = req.asset ?? tokenConfig.address;

    // The server advertises `amount` as a 6-decimal USD price (same encoding
    // as all other chains). BNB tokens use 18 decimals, so we re-scale for the
    // on-chain `amount` field. This matches Node CLI behavior at
    // src/client/node/index.ts §handleBNBPayment.
    const amountDisplay = Number(req.amount) / 1e6;
    this.ledger?.check(amountDisplay);
    const amountWei = BigInt(Math.floor(amountDisplay * 10 ** tokenConfig.decimals));
    const amountWeiStr = amountWei.toString();

    // Allowance check — throw NeedsApprovalError with enough detail for the
    // UI to offer an "Approve BNB" button.
    const provider = new ethers.JsonRpcProvider(evmChain.rpc);
    const erc20 = new ethers.Contract(
      tokenAddress,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      provider
    );
    const allowance = (await erc20.allowance(owner, spender)) as bigint;
    if (allowance < amountWei) {
      throw new NeedsApprovalError({
        chain: chainName,
        spender,
        token: 'USDC',
        currentAllowance: allowance.toString(),
        required: amountWei.toString(),
      });
    }

    // Check user has some native BNB for the eventual approve() gas — only
    // relevant for first-time users, but surfaces a clearer error than a
    // wallet-side "insufficient funds". Skip on testnet since faucets are easy.
    if (chainName === 'bnb') {
      const nativeBalance = await provider.getBalance(owner);
      if (nativeBalance < ethers.parseEther('0.0001') && allowance < amountWei) {
        throw new InsufficientBalanceError(
          `Insufficient BNB for approve gas (have ${ethers.formatEther(nativeBalance)}, need ~0.001 BNB)`
        );
      }
    }

    const envelope = buildBnbIntentTypedData({
      from: owner,
      to: req.payTo,
      amount: amountWeiStr,
      tokenAddress,
      service,
      nonce: Date.now(),
      deadline: Date.now() + 3600000,
      chainId: evmChain.chainId,
    });

    const signature = await this.signer.signTypedData(envelope);

    const payload = buildPaymentPayload({
      scheme: 'exact',
      network: chainNameToNetwork(chainName),
      payload: {
        intent: { ...envelope.message, signature },
        chainId: evmChain.chainId,
      },
      accepted: {
        scheme: 'exact',
        network: chainNameToNetwork(chainName),
        asset: tokenAddress,
        amount: amountWeiStr,
        payTo: req.payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? 300,
      },
    });

    const header = encodePaymentHeader(payload);
    return this.submitPayment(executeUrl, service, params, options, header, chainName, amountDisplay);
  }

  // ----- Solana (solana / solana_devnet) -----

  private async paySolana(
    executeUrl: string,
    service: string,
    params: Record<string, unknown>,
    req: X402PaymentRequirements,
    chainName: SolanaChainName,
    options: WebPayOptions
  ): Promise<Record<string, unknown>> {
    if (!this.signer.signSolanaTransaction) {
      throw new NotInitializedError('Signer does not support Solana — use solanaSigner(adapter) or composeSigners');
    }
    const ownerBase58 = await this.signer.getSolanaAddress?.();
    if (!ownerBase58) {
      throw new NotInitializedError('Solana wallet not connected');
    }
    if (!req.amount || !req.payTo) {
      throw new ServerError(402, 'Solana requirement missing amount or payTo');
    }

    const amountDisplay = Number(req.amount) / 1e6;
    this.ledger?.check(amountDisplay);

    const ownerPubkey = new PublicKey(ownerBase58);
    const recipientPubkey = new PublicKey(req.payTo);
    const extra = (req.extra ?? {}) as { solanaFeePayer?: string };
    const feePayerPubkey = extra.solanaFeePayer ? new PublicKey(extra.solanaFeePayer) : undefined;

    const unsignedTx = await createSolanaPaymentTransaction(
      ownerPubkey,
      recipientPubkey,
      BigInt(req.amount),
      chainName,
      feePayerPubkey,
      this.getSolanaConnection(chainName)
    );

    // Serialize without requiring all signatures so `partialSign: true` works
    // when the server is also signing as fee payer.
    const unsignedBytes = unsignedTx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const transactionBase64 = uint8ArrayToBase64(unsignedBytes);

    const signedTx = await this.signer.signSolanaTransaction({
      transactionBase64,
      partialSign: !!feePayerPubkey,
    });

    const payload = buildPaymentPayload({
      scheme: 'exact',
      network: chainNameToNetwork(chainName),
      payload: {
        signedTransaction: signedTx,
        sender: ownerBase58,
        chain: chainName,
      },
      accepted: {
        scheme: 'exact',
        network: chainNameToNetwork(chainName),
        asset: req.asset ?? SOLANA_CHAINS[chainName].tokens.USDC.mint,
        amount: req.amount,
        payTo: req.payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? 300,
      },
    });

    const header = encodePaymentHeader(payload);
    return this.submitPayment(executeUrl, service, params, options, header, chainName, amountDisplay);
  }
}
