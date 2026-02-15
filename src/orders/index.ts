/**
 * 订单管理模块
 */

import { randomBytes } from 'crypto';

export interface Order {
  orderId: string;
  prompt: string;
  imageUrl?: string;
  userId: string;
  price: number;
  chain: string;
  status: OrderStatus;
  createdAt: string;
  paidAt?: string;
  txHash?: string;
  payerAddress?: string;
  videoPath?: string;
  error?: string;
}

export type OrderStatus = 
  | 'pending'      // 等待支付
  | 'paid'         // 已支付
  | 'generating'   // 生成中
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'cancelled';   // 已取消

export interface CreateOrderParams {
  prompt: string;
  userId: string;
  price?: number;
  chain?: string;
  imageUrl?: string;
}

export interface OrderStore {
  get(orderId: string): Promise<Order | null>;
  set(order: Order): Promise<void>;
  findByUser(userId: string, status?: OrderStatus): Promise<Order[]>;
  list(limit?: number): Promise<Order[]>;
}

/**
 * 内存订单存储（默认实现）
 */
export class MemoryOrderStore implements OrderStore {
  private orders: Map<string, Order> = new Map();

  async get(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) || null;
  }

  async set(order: Order): Promise<void> {
    this.orders.set(order.orderId, order);
  }

  async findByUser(userId: string, status?: OrderStatus): Promise<Order[]> {
    const results: Order[] = [];
    for (const order of this.orders.values()) {
      if (order.userId === userId) {
        if (!status || order.status === status) {
          results.push(order);
        }
      }
    }
    return results.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async list(limit = 100): Promise<Order[]> {
    return Array.from(this.orders.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }
}

/**
 * 订单管理器
 */
export class OrderManager {
  private store: OrderStore;
  private defaultPrice: number;
  private defaultChain: string;

  constructor(options: {
    store?: OrderStore;
    defaultPrice?: number;
    defaultChain?: string;
  } = {}) {
    this.store = options.store || new MemoryOrderStore();
    this.defaultPrice = options.defaultPrice || 2.0;
    this.defaultChain = options.defaultChain || 'base';
  }

  /**
   * 生成订单ID
   */
  private generateOrderId(): string {
    return 'vo_' + randomBytes(4).toString('hex');
  }

  /**
   * 创建订单
   */
  async createOrder(params: CreateOrderParams): Promise<Order> {
    const order: Order = {
      orderId: this.generateOrderId(),
      prompt: params.prompt,
      imageUrl: params.imageUrl,
      userId: params.userId,
      price: params.price || this.defaultPrice,
      chain: params.chain || this.defaultChain,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await this.store.set(order);
    return order;
  }

  /**
   * 获取订单
   */
  async getOrder(orderId: string): Promise<Order | null> {
    return this.store.get(orderId);
  }

  /**
   * 更新订单
   */
  async updateOrder(orderId: string, updates: Partial<Order>): Promise<Order | null> {
    const order = await this.store.get(orderId);
    if (!order) return null;

    const updated = { ...order, ...updates };
    await this.store.set(updated);
    return updated;
  }

  /**
   * 查找用户的待支付订单
   */
  async findPendingOrder(userId: string): Promise<Order | null> {
    const orders = await this.store.findByUser(userId, 'pending');
    
    // 返回24小时内的待支付订单
    const now = Date.now();
    for (const order of orders) {
      const age = now - new Date(order.createdAt).getTime();
      if (age < 24 * 60 * 60 * 1000) {
        return order;
      }
    }
    return null;
  }

  /**
   * 标记订单为已支付
   */
  async markAsPaid(orderId: string, txHash: string, payerAddress?: string): Promise<Order | null> {
    return this.updateOrder(orderId, {
      status: 'paid',
      paidAt: new Date().toISOString(),
      txHash,
      payerAddress,
    });
  }

  /**
   * 标记订单为生成中
   */
  async markAsGenerating(orderId: string): Promise<Order | null> {
    return this.updateOrder(orderId, { status: 'generating' });
  }

  /**
   * 标记订单为完成
   */
  async markAsCompleted(orderId: string, videoPath: string): Promise<Order | null> {
    return this.updateOrder(orderId, {
      status: 'completed',
      videoPath,
    });
  }

  /**
   * 标记订单为失败
   */
  async markAsFailed(orderId: string, error: string): Promise<Order | null> {
    return this.updateOrder(orderId, {
      status: 'failed',
      error,
    });
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<Order | null> {
    return this.updateOrder(orderId, { status: 'cancelled' });
  }
}
