import { ServerConfig } from './types';
import type { HAProxyDataPlaneClient } from './client';

// ====================
// Transaction Manager for Atomic Operations
// ====================

export class TransactionManager {
  constructor(private client: HAProxyDataPlaneClient) {}

  /**
   * Execute multiple operations atomically within a transaction
   */
  async executeInTransaction<T>(
    operations: () => Promise<T>
  ): Promise<T> {
    const transaction = await this.client.beginTransaction();

    try {
      // Override the http client methods to include transaction_id in all requests
      const originalGet = this.client.httpClient.get;
      const originalPost = this.client.httpClient.post;
      const originalPut = this.client.httpClient.put;
      const originalDelete = this.client.httpClient.delete;
      const originalAddServer = this.client.addServer;

      // Override addServer to use non-transactional version
      this.client.addServer = (backendName: string, config: ServerConfig) => {
        return this.client.addServerInternal(backendName, config, false);
      };

      // Add transaction_id to all requests, but skip transaction-related endpoints
      (this.client.httpClient.get as any) = (url: string, config?: any) => {
        return originalGet.call(this.client.httpClient, this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, config);
      };

      (this.client.httpClient.post as any) = (url: string, data?: any, config?: any) => {
        return originalPost.call(this.client.httpClient, this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, data, config);
      };

      (this.client.httpClient.put as any) = (url: string, data?: any, config?: any) => {
        return originalPut.call(this.client.httpClient, this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, data, config);
      };

      (this.client.httpClient.delete as any) = (url: string, config?: any) => {
        return originalDelete.call(this.client.httpClient, this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, config);
      };

      try {
        const result = await operations();
        await this.client.commitTransaction(transaction);
        return result;
      } finally {
        // Restore original methods
        this.client.httpClient.get = originalGet;
        this.client.httpClient.post = originalPost;
        this.client.httpClient.put = originalPut;
        this.client.httpClient.delete = originalDelete;
        this.client.addServer = originalAddServer;
      }
    } catch (error) {
      await this.client.rollbackTransaction(transaction);
      throw error;
    }
  }

  /**
   * Check if URL should use transaction_id
   */
  private shouldUseTransaction(url: string): boolean {
    // Don't add transaction_id to transaction management endpoints or version endpoints
    return !url.includes('/transactions') && !url.includes('/version');
  }

  /**
   * Helper method to add transaction_id to requests
   */
  withTransaction(transactionId: string, url: string): string {
    // Remove version parameter if present since transaction_id and version are mutually exclusive
    const urlParts = url.split('?');
    const baseUrl = urlParts[0];
    let queryParams = '';

    if (urlParts.length > 1) {
      const params = new URLSearchParams(urlParts[1]);
      // Remove version parameter to avoid conflict with transaction_id
      params.delete('version');
      if (params.toString()) {
        queryParams = `?${params.toString()}`;
      }
    }

    const separator = queryParams ? '&' : '?';
    return `${baseUrl}${queryParams}${separator}transaction_id=${transactionId}`;
  }
}
