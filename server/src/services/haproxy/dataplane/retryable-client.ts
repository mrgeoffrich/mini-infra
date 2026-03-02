import { BackendConfig, ServerConfig, FrontendConfig } from './types';
import { HAProxyDataPlaneClient } from './client';

// ====================
// Retryable HAProxy Client with Exponential Backoff
// ====================

export class RetryableHAProxyClient extends HAProxyDataPlaneClient {
  /**
   * Override createBackend with retry logic
   */
  async createBackend(config: BackendConfig): Promise<void> {
    return this.withRetry(() => super.createBackend(config));
  }

  /**
   * Override addServer with retry logic
   */
  async addServer(backendName: string, config: ServerConfig): Promise<void> {
    return this.withRetry(() => super.addServer(backendName, config));
  }

  /**
   * Override deleteBackend with retry logic
   */
  async deleteBackend(name: string): Promise<void> {
    return this.withRetry(() => super.deleteBackend(name));
  }

  /**
   * Override deleteServer with retry logic
   */
  async deleteServer(backendName: string, serverName: string): Promise<void> {
    return this.withRetry(() => super.deleteServer(backendName, serverName));
  }

  /**
   * Override createFrontend with retry logic
   */
  async createFrontend(config: FrontendConfig): Promise<void> {
    return this.withRetry(() => super.createFrontend(config));
  }

  /**
   * Override addFrontendBind with retry logic
   */
  async addFrontendBind(frontendName: string, address: string, port: number, sslOptions?: { ssl?: boolean; ssl_certificate?: string }): Promise<void> {
    return this.withRetry(() => super.addFrontendBind(frontendName, address, port, sslOptions));
  }
}
