import type { HAProxyDataPlaneClient } from './client';

// ====================
// Transaction Manager for Atomic Operations
// ====================

/**
 * Thin wrapper that delegates to HAProxyDataPlaneClientBase.executeInTransaction().
 * Kept for backward compatibility — callers can also call client.executeInTransaction() directly.
 */
export class TransactionManager {
  constructor(private client: HAProxyDataPlaneClient) {}

  async executeInTransaction<T>(operations: () => Promise<T>): Promise<T> {
    return this.client.executeInTransaction(operations);
  }
}
