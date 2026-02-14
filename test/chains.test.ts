/**
 * Chains 配置单元测试
 */

import { describe, it, expect } from 'vitest';
import { CHAINS, getChain, listChains, getChainById } from '../src/chains/index.js';

describe('Chains Configuration', () => {
  describe('CHAINS', () => {
    it('should have all required chains', () => {
      expect(CHAINS.base).toBeDefined();
      expect(CHAINS.base_sepolia).toBeDefined();
      expect(CHAINS.polygon).toBeDefined();
      expect(CHAINS.ethereum).toBeDefined();
      expect(CHAINS.sepolia).toBeDefined();
    });

    it('should have correct chain IDs', () => {
      expect(CHAINS.base.chainId).toBe(8453);
      expect(CHAINS.base_sepolia.chainId).toBe(84532);
      expect(CHAINS.polygon.chainId).toBe(137);
      expect(CHAINS.ethereum.chainId).toBe(1);
      expect(CHAINS.sepolia.chainId).toBe(11155111);
    });

    it('should have USDC contract addresses', () => {
      Object.values(CHAINS).forEach(chain => {
        expect(chain.usdc).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });

    it('should have RPC URLs', () => {
      Object.values(CHAINS).forEach(chain => {
        expect(chain.rpc).toMatch(/^https?:\/\//);
      });
    });

    it('should have explorer URLs', () => {
      Object.values(CHAINS).forEach(chain => {
        expect(chain.explorer).toMatch(/^https?:\/\//);
        expect(chain.explorerTx).toMatch(/^https?:\/\//);
      });
    });
  });

  describe('getChain', () => {
    it('should return chain config by name', () => {
      const base = getChain('base');
      expect(base.name).toBe('Base');
      expect(base.chainId).toBe(8453);
    });

    it('should throw for invalid chain', () => {
      expect(() => getChain('invalid' as any)).toThrow('Unsupported chain');
    });
  });

  describe('listChains', () => {
    it('should return all chain names', () => {
      const chains = listChains();
      expect(chains).toContain('base');
      expect(chains).toContain('base_sepolia');
      expect(chains).toContain('polygon');
      expect(chains).toContain('ethereum');
      expect(chains).toContain('sepolia');
    });
  });

  describe('getChainById', () => {
    it('should return chain config by ID', () => {
      const base = getChainById(8453);
      expect(base?.name).toBe('Base');
    });

    it('should return undefined for invalid ID', () => {
      const chain = getChainById(99999);
      expect(chain).toBeUndefined();
    });
  });
});

describe('USDC Contract Addresses', () => {
  it('Base mainnet USDC should be correct', () => {
    expect(CHAINS.base.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  it('Base Sepolia USDC should be correct', () => {
    expect(CHAINS.base_sepolia.usdc).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('Polygon USDC should be correct', () => {
    expect(CHAINS.polygon.usdc).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
  });

  it('Ethereum USDC should be correct', () => {
    expect(CHAINS.ethereum.usdc).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });
});
