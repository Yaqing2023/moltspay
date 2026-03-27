/**
 * AgentWallet - Alias for PermitWallet
 * 
 * This is for backward compatibility with x402 client code.
 * TODO: Consider if AgentWallet needs distinct features from PermitWallet
 */

import { PermitWallet, type PermitWalletConfig } from '../wallet/PermitWallet.js';

export type WalletConfig = PermitWalletConfig;

export class AgentWallet extends PermitWallet {
  constructor(config: WalletConfig) {
    super(config);
  }
}

export type { PermitWalletConfig };
