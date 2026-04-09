import { HttpClient, HttpError, createHttpClient, isHttpError } from '../../../lib/http-client';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import DockerService from '../../docker';
import { getOwnContainerId } from '../../self-update';
import { HAProxyEndpointInfo } from './types';

const logger = loadbalancerLogger();

// ====================
// HAProxy DataPlane API Client — Base
// ====================

export class HAProxyDataPlaneClientBase {
  httpClient: HttpClient;
  private dockerService: DockerService;
  private endpointInfo: HAProxyEndpointInfo | null = null;
  private username = 'admin';
  private password = 'adminpwd';

  constructor() {
    this.dockerService = DockerService.getInstance();

    // Initialize http client with defaults
    this.httpClient = createHttpClient({
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  }

  // ====================
  // Initialization and Discovery
  // ====================

  /**
   * Initialize the client and discover HAProxy endpoint
   */
  async initialize(haproxyContainerId: string): Promise<void> {
    try {
      logger.info(
        { haproxyContainerId: haproxyContainerId.slice(0, 12) },
        'Initializing HAProxy DataPlane client'
      );

      // Discover HAProxy endpoint
      this.endpointInfo = await this.discoverHAProxyEndpoint(haproxyContainerId);

      // Configure http client with discovered endpoint
      this.httpClient.defaults.baseURL = this.endpointInfo.baseUrl;
      this.httpClient.defaults.auth = {
        username: this.username,
        password: this.password
      };

      // Test connection
      await this.testConnection();

      logger.info(
        {
          baseUrl: this.endpointInfo.baseUrl,
          containerName: this.endpointInfo.containerName,
          containerId: this.endpointInfo.containerId.slice(0, 12)
        },
        'HAProxy DataPlane client initialized successfully'
      );
    } catch (error) {
      logger.error(
        {
          haproxyContainerId: haproxyContainerId.slice(0, 12),
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        'Failed to initialize HAProxy DataPlane client'
      );
      throw error;
    }
  }

  /**
   * Discover HAProxy DataPlane API endpoint from container.
   * Uses a shared Docker network (e.g., the dataplane network) to reach the DataPlane API.
   */
  private async discoverHAProxyEndpoint(containerId: string): Promise<HAProxyEndpointInfo> {
    try {
      await this.dockerService.initialize();
      const docker = await this.dockerService.getDockerInstance();

      const container = docker.getContainer(containerId);
      const containerInfo = await container.inspect();

      if (!containerInfo) {
        throw new Error('HAProxy container not found or not accessible');
      }

      // Get container name (remove leading slash)
      const containerName = containerInfo.Name?.replace(/^\//, '') || containerId.slice(0, 12);

      return this.discoverViaContainerNetwork(docker, containerInfo, containerName, containerId);
    } catch (error) {
      logger.error(
        {
          containerId: containerId.slice(0, 12),
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        'Failed to discover HAProxy DataPlane endpoint'
      );
      throw error;
    }
  }

  /**
   * Discover the DataPlane API endpoint via Docker container networking.
   * Requires mini-infra and HAProxy to share a network (e.g., the dataplane network).
   */
  private async discoverViaContainerNetwork(
    docker: import('dockerode'),
    containerInfo: import('dockerode').ContainerInspectInfo,
    containerName: string,
    containerId: string
  ): Promise<HAProxyEndpointInfo> {
    const networks = containerInfo.NetworkSettings?.Networks || {};
    const networkEntries = Object.entries(networks);

    if (networkEntries.length === 0) {
      throw new Error('HAProxy container has no network connections');
    }

    // Determine our own container ID using the same robust detection as self-update
    const selfId = getOwnContainerId();
    if (!selfId) {
      throw new Error(
        'DataPlane API port 5555 is not bound to a host port and container network fallback ' +
        'is unavailable (mini-infra does not appear to be running in Docker)'
      );
    }

    const myContainer = docker.getContainer(selfId);
    const myInfo = await myContainer.inspect();
    const myNetworks = Object.keys(myInfo.NetworkSettings?.Networks || {});

    // Find a shared network between mini-infra and HAProxy
    for (const [netName, netInfo] of networkEntries) {
      if (myNetworks.includes(netName) && netInfo.IPAddress) {
        logger.info(
          { network: netName, containerIp: netInfo.IPAddress },
          'Found shared network with HAProxy container'
        );
        return {
          baseUrl: `http://${netInfo.IPAddress}:5555/v3`,
          containerName,
          containerId,
        };
      }
    }

    throw new Error(
      'No shared network between mini-infra and HAProxy. ' +
      'Apply the dataplane-network stack and re-apply the HAProxy stack to establish connectivity.'
    );
  }

  /**
   * Test connection to HAProxy DataPlane API
   */
  private async testConnection(): Promise<void> {
    try {
      const response = await this.httpClient.get('/info');

      if (response.status !== 200) {
        throw new Error(`DataPlane API health check failed with status ${response.status}`);
      }

      logger.debug(
        {
          status: response.status,
          version: response.data?.api?.version,
          haproxyVersion: response.data?.haproxy?.version
        },
        'DataPlane API connection test successful'
      );
    } catch (error) {
      if (isHttpError(error)) {
        const message = error.response?.data?.message || error.message;
        throw new Error(`DataPlane API connection failed: ${message}`);
      }
      throw error;
    }
  }

  // ====================
  // Version Management
  // ====================

  /**
   * Get current configuration version
   */
  async getVersion(): Promise<number> {
    try {
      const response = await this.httpClient.get('/services/haproxy/configuration/version');
      // API returns plain number, not an object
      return typeof response.data === 'number' ? response.data : parseInt(response.data, 10);
    } catch (error) {
      this.handleApiError(error, 'get version');
      throw error;
    }
  }

  // ====================
  // Transaction Management
  // ====================

  /**
   * Begin a new transaction
   */
  async beginTransaction(): Promise<string> {
    try {
      const version = await this.getVersion();
      const response = await this.httpClient.post(`/services/haproxy/transactions?version=${version}`, {
        version
      });

      const transactionId = response.data.id;

      logger.debug(
        { transactionId, version },
        'Started HAProxy configuration transaction'
      );

      return transactionId;
    } catch (error) {
      this.handleApiError(error, 'begin transaction');
      throw error;
    }
  }

  /**
   * Commit a transaction
   */
  async commitTransaction(transactionId: string): Promise<void> {
    try {
      await this.httpClient.put(`/services/haproxy/transactions/${transactionId}`, {
        force_reload: true
      });

      logger.info(
        { transactionId },
        'Committed HAProxy configuration transaction'
      );
    } catch (error) {
      this.handleApiError(error, 'commit transaction', { transactionId });
    }
  }

  /**
   * Rollback a transaction
   */
  async rollbackTransaction(transactionId: string): Promise<void> {
    try {
      await this.httpClient.delete(`/services/haproxy/transactions/${transactionId}`);

      logger.info(
        { transactionId },
        'Rolled back HAProxy configuration transaction'
      );
    } catch (error) {
      this.handleApiError(error, 'rollback transaction', { transactionId });
    }
  }

  // ====================
  // Utility Methods
  // ====================

  /**
   * Get client connection info
   */
  getConnectionInfo(): HAProxyEndpointInfo | null {
    return this.endpointInfo;
  }

  /**
   * Check if client is initialized
   */
  isInitialized(): boolean {
    return this.endpointInfo !== null;
  }

  /**
   * Handle API errors consistently
   */
  handleApiError(error: unknown, operation: string, context?: Record<string, any>): void {
    if (isHttpError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      const errorDetails = {
        operation,
        status,
        message,
        url: error.config?.url,
        ...context
      };

      logger.error(errorDetails, `HAProxy DataPlane API ${operation} failed`);

      // Handle specific error codes as per specification
      switch (status) {
        case 409:
          throw new Error(`Version conflict: ${message}. Please retry with the latest version.`);
        case 404:
          throw new Error(`Resource not found: ${message}`);
        case 401:
          throw new Error(`Authentication failed: ${message}`);
        case 400:
          throw new Error(`Bad request: ${message}`);
        default:
          throw new Error(`HAProxy ${operation} failed: ${message} (Status: ${status})`);
      }
    } else {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { operation, error: errorMessage, ...context },
        `HAProxy DataPlane API ${operation} failed with unexpected error`
      );

      throw new Error(`HAProxy ${operation} failed: ${errorMessage}`);
    }
  }

  /**
   * Execute operation with retry logic for version conflicts
   */
  withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    return this._withRetryInternal(operation, maxRetries, baseDelay);
  }

  private async _withRetryInternal<T>(
    operation: () => Promise<T>,
    maxRetries: number,
    baseDelay: number
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        // Only retry on version conflicts
        if (error.message?.includes('Version conflict') && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.debug(
            { attempt, delay, error: error.message },
            'Retrying after version conflict'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw lastError!;
  }
}
