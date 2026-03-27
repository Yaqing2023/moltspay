/**
 * MoltsPay Client Types
 */

// Client configuration (stored in ~/.moltspay/)
export interface ClientConfig {
  chain: string;
  limits: {
    maxPerTx: number;
    maxPerDay: number;
  };
}

// Wallet data (stored in ~/.moltspay/wallet.json)
export interface WalletData {
  address: string;
  privateKey: string;
  createdAt: number;
}

// Payment response from server
export interface PaymentRequired {
  message: string;
  payment: {
    chargeId: string;
    service: string;
    amount: number;
    currency: string;
    wallet: string;
    chain: string;
    expiresAt: number;
  };
}

// Service info from server
export interface ServiceInfo {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  input: Record<string, any>;
  output: Record<string, any>;
  available: boolean;
  provider?: ProviderInfo;  // For marketplace listings
  endpoint?: string;  // Custom endpoint path (e.g., for Cloudflare Workers)
}

// Provider info from server
export interface ProviderInfo {
  name: string;
  username?: string;
  description?: string;
  wallet: string;
  chain?: string;
  chains?: string[] | { chain: string }[];  // Multi-chain support
}

// Services response from server
export interface ServicesResponse {
  provider?: ProviderInfo;  // Optional for marketplace listings
  services: ServiceInfo[];
}

// Verify response from server
export interface VerifyResponse {
  status: string;
  chargeId: string;
  txHash: string;
  result: Record<string, any>;
}

// Client options
export interface MoltsPayClientOptions {
  configDir?: string;  // Default: ~/.moltspay
}
