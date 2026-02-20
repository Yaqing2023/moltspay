/**
 * Facilitator Registry
 * 
 * Central registry for all available facilitators.
 * Supports selection strategies for failover, load balancing, etc.
 */

import {
  Facilitator,
  FacilitatorConfig,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
} from './interface.js';
import { CDPFacilitator, CDPFacilitatorConfig } from './cdp.js';

/**
 * Selection strategy for choosing facilitators
 */
export type SelectionStrategy = 
  | 'failover'    // Use primary, switch to fallback on failure
  | 'cheapest'    // Use facilitator with lowest fees
  | 'fastest'     // Use first responder
  | 'random'      // Random selection (load balancing)
  | 'roundrobin'; // Rotate through facilitators

/**
 * Facilitator selection configuration
 */
export interface FacilitatorSelection {
  /** Primary facilitator to use */
  primary: string;
  /** Fallback facilitators (in order of preference) */
  fallback?: string[];
  /** Selection strategy */
  strategy?: SelectionStrategy;
  /** Per-facilitator config overrides */
  config?: Record<string, FacilitatorConfig>;
}

/**
 * Factory function type for creating facilitators
 */
type FacilitatorFactory = (config?: FacilitatorConfig) => Facilitator;

/**
 * Facilitator Registry
 * 
 * Manages available facilitators and provides selection logic.
 */
export class FacilitatorRegistry {
  private factories: Map<string, FacilitatorFactory> = new Map();
  private instances: Map<string, Facilitator> = new Map();
  private selection: FacilitatorSelection;
  private roundRobinIndex = 0;
  
  constructor(selection?: FacilitatorSelection) {
    // Register built-in facilitators
    this.registerFactory('cdp', (config) => new CDPFacilitator(config as CDPFacilitatorConfig));
    
    // Default selection
    this.selection = selection || { primary: 'cdp', strategy: 'failover' };
  }
  
  /**
   * Register a new facilitator factory
   */
  registerFactory(name: string, factory: FacilitatorFactory): void {
    this.factories.set(name, factory);
  }
  
  /**
   * Get or create a facilitator instance
   */
  get(name: string, config?: FacilitatorConfig): Facilitator {
    // Check cache first
    if (this.instances.has(name)) {
      return this.instances.get(name)!;
    }
    
    // Look up factory
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Unknown facilitator: ${name}. Available: ${Array.from(this.factories.keys()).join(', ')}`);
    }
    
    // Merge config from selection
    const mergedConfig = {
      ...this.selection.config?.[name],
      ...config,
    };
    
    // Create and cache instance
    const instance = factory(mergedConfig);
    this.instances.set(name, instance);
    return instance;
  }
  
  /**
   * Get all configured facilitator names
   */
  getConfiguredNames(): string[] {
    const names = [this.selection.primary];
    if (this.selection.fallback) {
      names.push(...this.selection.fallback);
    }
    return names;
  }
  
  /**
   * Get list of facilitators based on selection strategy
   */
  private async getOrderedFacilitators(network: string): Promise<Facilitator[]> {
    const names = this.getConfiguredNames();
    const facilitators: Facilitator[] = [];
    
    for (const name of names) {
      try {
        const f = this.get(name);
        if (f.supportsNetwork(network)) {
          facilitators.push(f);
        }
      } catch (err) {
        console.warn(`[Registry] Failed to get facilitator ${name}:`, err);
      }
    }
    
    if (facilitators.length === 0) {
      throw new Error(`No facilitators available for network: ${network}`);
    }
    
    // Apply strategy
    switch (this.selection.strategy) {
      case 'random':
        return this.shuffle(facilitators);
      
      case 'roundrobin':
        this.roundRobinIndex = (this.roundRobinIndex + 1) % facilitators.length;
        return [
          ...facilitators.slice(this.roundRobinIndex),
          ...facilitators.slice(0, this.roundRobinIndex),
        ];
      
      case 'cheapest':
        return this.sortByCheapest(facilitators);
      
      case 'fastest':
        return this.sortByFastest(facilitators);
      
      case 'failover':
      default:
        return facilitators;
    }
  }
  
  private shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  
  private async sortByCheapest(facilitators: Facilitator[]): Promise<Facilitator[]> {
    const withFees = await Promise.all(
      facilitators.map(async (f) => {
        try {
          const fee = await f.getFee?.();
          return { facilitator: f, perTx: fee?.perTx ?? Infinity };
        } catch {
          return { facilitator: f, perTx: Infinity };
        }
      })
    );
    withFees.sort((a, b) => a.perTx - b.perTx);
    return withFees.map(w => w.facilitator);
  }
  
  private async sortByFastest(facilitators: Facilitator[]): Promise<Facilitator[]> {
    const withLatency = await Promise.all(
      facilitators.map(async (f) => {
        try {
          const health = await f.healthCheck();
          return { facilitator: f, latency: health.latencyMs ?? Infinity };
        } catch {
          return { facilitator: f, latency: Infinity };
        }
      })
    );
    withLatency.sort((a, b) => a.latency - b.latency);
    return withLatency.map(w => w.facilitator);
  }
  
  /**
   * Verify payment using configured facilitators
   */
  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult & { facilitator: string }> {
    const network = paymentPayload.accepted?.network || paymentPayload.network || requirements.network;
    const facilitators = await this.getOrderedFacilitators(network);
    
    let lastError: string | undefined;
    
    for (const f of facilitators) {
      try {
        console.log(`[Registry] Trying ${f.name} for verify...`);
        const result = await f.verify(paymentPayload, requirements);
        
        if (result.valid) {
          console.log(`[Registry] ${f.name} verify succeeded`);
          return { ...result, facilitator: f.name };
        }
        
        lastError = result.error;
        console.log(`[Registry] ${f.name} verify failed: ${result.error}`);
        
        // For failover strategy, only try next if it's a network/server error
        if (this.selection.strategy === 'failover' && !this.isTransientError(result.error)) {
          // Permanent error (e.g., invalid signature) - don't try others
          break;
        }
      } catch (err: any) {
        lastError = err.message;
        console.error(`[Registry] ${f.name} error:`, err.message);
      }
    }
    
    return {
      valid: false,
      error: lastError || 'All facilitators failed',
      facilitator: 'none',
    };
  }
  
  /**
   * Settle payment using configured facilitators
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult & { facilitator: string }> {
    const network = paymentPayload.accepted?.network || paymentPayload.network || requirements.network;
    const facilitators = await this.getOrderedFacilitators(network);
    
    let lastError: string | undefined;
    
    for (const f of facilitators) {
      try {
        console.log(`[Registry] Trying ${f.name} for settle...`);
        const result = await f.settle(paymentPayload, requirements);
        
        if (result.success) {
          console.log(`[Registry] ${f.name} settle succeeded: ${result.transaction}`);
          return { ...result, facilitator: f.name };
        }
        
        lastError = result.error;
        console.log(`[Registry] ${f.name} settle failed: ${result.error}`);
      } catch (err: any) {
        lastError = err.message;
        console.error(`[Registry] ${f.name} error:`, err.message);
      }
    }
    
    return {
      success: false,
      error: lastError || 'All facilitators failed',
      facilitator: 'none',
    };
  }
  
  /**
   * Check health of all configured facilitators
   */
  async healthCheckAll(): Promise<Record<string, HealthCheckResult>> {
    const results: Record<string, HealthCheckResult> = {};
    
    for (const name of this.getConfiguredNames()) {
      try {
        const f = this.get(name);
        results[name] = await f.healthCheck();
      } catch (err: any) {
        results[name] = { healthy: false, error: err.message };
      }
    }
    
    return results;
  }
  
  /**
   * Check if an error is transient (network/server issue) vs permanent (bad request)
   */
  private isTransientError(error?: string): boolean {
    if (!error) return true;
    const transientPatterns = [
      /timeout/i,
      /network/i,
      /connection/i,
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
      /503/,
      /502/,
      /500/,
    ];
    return transientPatterns.some(p => p.test(error));
  }
  
  /**
   * Update selection configuration
   */
  setSelection(selection: FacilitatorSelection): void {
    this.selection = selection;
    // Clear cached instances to pick up new config
    this.instances.clear();
  }
  
  /**
   * Get current selection configuration
   */
  getSelection(): FacilitatorSelection {
    return { ...this.selection };
  }
}

// Default registry instance
let defaultRegistry: FacilitatorRegistry | null = null;

/**
 * Get the default facilitator registry
 */
export function getDefaultRegistry(): FacilitatorRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new FacilitatorRegistry();
  }
  return defaultRegistry;
}

/**
 * Create a new registry with custom selection
 */
export function createRegistry(selection?: FacilitatorSelection): FacilitatorRegistry {
  return new FacilitatorRegistry(selection);
}
