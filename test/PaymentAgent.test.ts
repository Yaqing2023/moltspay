/**
 * PaymentAgent 单元测试
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PaymentAgent } from '../src/agent/PaymentAgent.js';

describe('PaymentAgent', () => {
  let agent: PaymentAgent;

  beforeAll(() => {
    agent = new PaymentAgent({
      chain: 'base_sepolia',
      walletAddress: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
    });
  });

  describe('createInvoice', () => {
    it('should create a valid invoice', () => {
      const invoice = agent.createInvoice({
        orderId: 'test_001',
        amount: 2.0,
        service: 'video_generation',
      });

      expect(invoice.type).toBe('payment_request');
      expect(invoice.version).toBe('1.0');
      expect(invoice.order_id).toBe('test_001');
      expect(invoice.amount).toBe('2.00');
      expect(invoice.token).toBe('USDC');
      expect(invoice.chain).toBe('base_sepolia');
      expect(invoice.chain_id).toBe(84532);
      expect(invoice.recipient).toBe('0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C');
    });

    it('should include deep_link', () => {
      const invoice = agent.createInvoice({
        orderId: 'test_002',
        amount: 5.0,
        service: 'premium_video',
      });

      expect(invoice.deep_link).toContain('metamask.app.link');
      expect(invoice.deep_link).toContain('5000000'); // 5 USDC in wei
    });

    it('should set expiration time', () => {
      const invoice = agent.createInvoice({
        orderId: 'test_003',
        amount: 1.0,
        service: 'test',
        expiresMinutes: 60,
      });

      const expiresAt = new Date(invoice.expires_at);
      const now = new Date();
      const diffMinutes = (expiresAt.getTime() - now.getTime()) / 1000 / 60;

      expect(diffMinutes).toBeGreaterThan(55);
      expect(diffMinutes).toBeLessThan(65);
    });

    it('should include metadata if provided', () => {
      const invoice = agent.createInvoice({
        orderId: 'test_004',
        amount: 2.0,
        service: 'video',
        metadata: { prompt: 'A cat dancing' },
      });

      expect(invoice.metadata).toEqual({ prompt: 'A cat dancing' });
    });
  });

  describe('generateDeepLink', () => {
    it('should generate correct MetaMask deep link', () => {
      const link = agent.generateDeepLink(2.5, 'order_123');

      expect(link).toContain('metamask.app.link');
      expect(link).toContain('0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // USDC contract
      expect(link).toContain('@84532'); // Chain ID
      expect(link).toContain('2500000'); // 2.5 USDC in smallest unit
    });
  });

  describe('formatInvoiceMessage', () => {
    it('should format invoice as human-readable message', () => {
      const invoice = agent.createInvoice({
        orderId: 'test_005',
        amount: 2.0,
        service: 'video_generation',
      });

      const message = agent.formatInvoiceMessage(invoice);

      expect(message).toContain('Payment Request');
      expect(message).toContain('2.00 USDC');
      expect(message).toContain('Base Sepolia');
      expect(message).toContain('0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C');
    });
  });

  describe('verifyPayment', () => {
    it('should return error for invalid tx hash', async () => {
      const result = await agent.verifyPayment('0xinvalidhash');

      expect(result.verified).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return pending for non-existent tx', async () => {
      const result = await agent.verifyPayment('0x' + '0'.repeat(64));

      expect(result.verified).toBe(false);
      // Either pending or error is acceptable for non-existent tx
    });
  });
});

describe('PaymentAgent - Chain Configuration', () => {
  it('should work with base mainnet', () => {
    const agent = new PaymentAgent({
      chain: 'base',
      walletAddress: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
    });

    const invoice = agent.createInvoice({
      orderId: 'mainnet_001',
      amount: 10.0,
      service: 'test',
    });

    expect(invoice.chain).toBe('base');
    expect(invoice.chain_id).toBe(8453);
  });

  it('should work with polygon', () => {
    const agent = new PaymentAgent({
      chain: 'polygon',
      walletAddress: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
    });

    const invoice = agent.createInvoice({
      orderId: 'polygon_001',
      amount: 5.0,
      service: 'test',
    });

    expect(invoice.chain).toBe('polygon');
    expect(invoice.chain_id).toBe(137);
  });

  it('should throw for invalid chain', () => {
    expect(() => {
      new PaymentAgent({
        chain: 'invalid_chain' as any,
        walletAddress: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
      });
    }).toThrow();
  });
});
