import { HttpClient, createHttpClient, isHttpError, type HttpRequestConfig } from '../../../lib/http-client';
import { getLogger } from '../../../lib/logger-factory';
import { ErrorCode } from '@mini-infra/types';
import { ConflictError, NotFoundError, InternalError } from '../../../lib/errors';
import DockerService from '../../docker';
import { getOwnContainerId } from '../../self-update';
import { HAProxyEndpointInfo, ServerConfig } from './types';

const logger = getLogger("haproxy", "base");

/**
 * Best-effort mapping from a DataPlane `operation` label (e.g. "delete
 * backend switching rule", "add ACL") to a domain resource type, used to
 * enrich the 404 taxonomy error's `resource.type`. Order matters — more
 * specific multi-word operations must be checked before their substrings.
 */
function inferHaproxyResourceType(operation: string): string {
  const op = operation.toLowerCase();
  if (op.includes('switching rule')) return 'haproxySwitchingRule';
  if (op.includes('ssl certificate')) return 'haproxyCertificate';
  if (op.includes('http request rule')) return 'haproxyHttpRequestRule';
  if (op.includes('frontend')) return 'haproxyFrontend';
  if (op.includes('backend')) return 'haproxyBackend';
  if (op.includes('server')) return 'haproxyServer';
  if (op.includes('acl')) return 'haproxyAcl';
  return 'haproxyResource';
}

/** Picks the first name-like identifier out of a `handleApiError` context bag. */
function inferHaproxyResourceName(context?: Record<string, unknown>): string | undefined {
  if (!context) return undefined;
  const candidate =
    context.frontendName ?? context.backendName ?? context.serverName ?? context.aclName ?? context.filename;
  return typeof candidate === 'string' ? candidate : undefined;
}

// ====================
// HAProxy DataPlane API Client — Base
// ====================

export class HAProxyDataPlaneClientBase {
  /** @internal — do not access outside the dataplane module; use typed methods instead */
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
        throw new InternalError('HAProxy container not found or not accessible');
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
      throw new InternalError('HAProxy container has no network connections');
    }

    // Determine our own container ID using the same robust detection as self-update
    const selfId = getOwnContainerId();
    if (!selfId) {
      throw new InternalError(
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

    throw new InternalError(
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
        throw new InternalError(`DataPlane API health check failed with status ${response.status}`);
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
        const message = error.response?.data?.message || (error instanceof Error ? error.message : String(error));
        throw new InternalError(`DataPlane API connection failed: ${message}`);
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

  /**
   * Execute multiple operations atomically within a transaction.
   * Temporarily patches httpClient methods to inject transaction_id into all
   * configuration-endpoint URLs, stripping any version= parameter first.
   */
  async executeInTransaction<T>(operations: () => Promise<T>): Promise<T> {
    const transaction = await this.beginTransaction();

    try {
      const originalGet = this.httpClient.get;
      const originalPost = this.httpClient.post;
      const originalPut = this.httpClient.put;
      const originalDelete = this.httpClient.delete;

      // addServer / addServerInternal are mixed in downstream — save them
      // using duck-typing so the base class doesn't depend on the mixin.
      const self = this as unknown as {
        addServer?: (backendName: string, config: ServerConfig) => Promise<unknown>;
        addServerInternal?: (backendName: string, config: ServerConfig, useTransaction: boolean) => Promise<unknown>;
      };
      const originalAddServer = self.addServer;

      // Override addServer to use non-transactional version inside the transaction
      const addServerInternal = self.addServerInternal;
      if (typeof addServerInternal === 'function') {
        self.addServer = (backendName: string, config: ServerConfig) =>
          addServerInternal.call(self, backendName, config, false);
      }

      const shouldUse = (url: string) =>
        !url.includes('/transactions') && !url.includes('/version');

      const withTxn = (url: string): string => {
        const [base, qs] = url.split('?');
        let queryParams = '';
        if (qs) {
          const params = new URLSearchParams(qs);
          params.delete('version');
          if (params.toString()) queryParams = `?${params.toString()}`;
        }
        const sep = queryParams ? '&' : '?';
        return `${base}${queryParams}${sep}transaction_id=${transaction}`;
      };

      this.httpClient.get = ((url: string, config?: HttpRequestConfig) =>
        originalGet.call(this.httpClient, shouldUse(url) ? withTxn(url) : url, config)) as HttpClient["get"];

      this.httpClient.post = ((url: string, data?: unknown, config?: HttpRequestConfig) =>
        originalPost.call(this.httpClient, shouldUse(url) ? withTxn(url) : url, data, config)) as HttpClient["post"];

      this.httpClient.put = ((url: string, data?: unknown, config?: HttpRequestConfig) =>
        originalPut.call(this.httpClient, shouldUse(url) ? withTxn(url) : url, data, config)) as HttpClient["put"];

      this.httpClient.delete = ((url: string, config?: HttpRequestConfig) =>
        originalDelete.call(this.httpClient, shouldUse(url) ? withTxn(url) : url, config)) as HttpClient["delete"];

      try {
        const result = await operations();
        await this.commitTransaction(transaction);
        return result;
      } finally {
        this.httpClient.get = originalGet;
        this.httpClient.post = originalPost;
        this.httpClient.put = originalPut;
        this.httpClient.delete = originalDelete;
        if (originalAddServer) self.addServer = originalAddServer;
      }
    } catch (error) {
      await this.rollbackTransaction(transaction);
      throw error;
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
  handleApiError(error: unknown, operation: string, context?: Record<string, unknown>): void {
    if (isHttpError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.message || (error instanceof Error ? error.message : String(error));
      const errorDetails = {
        operation,
        status,
        message,
        url: error.config?.url,
        ...context
      };

      logger.error(errorDetails, `HAProxy DataPlane API ${operation} failed`);

      // Handle specific error codes as per specification. 409 (concurrent
      // config change) and 404 (acting on a resource that doesn't exist in
      // HAProxy) are the two cases with clear, actionable domain meaning —
      // promoted to the taxonomy so every dataplane call site gets a
      // correctly-attributed 409/404 for free. 401 is deliberately NOT
      // mapped to `UnauthorizedError`: it means the DataPlane API's own
      // admin/adminpwd basic-auth failed (an infra/config problem), not that
      // the calling mini-infra user is unauthenticated — throwing our
      // `UnauthorizedError` here would incorrectly trip the client's global
      // 401-session-expiry handler. 400 usually reflects a malformed
      // request WE built rather than something the user can fix, so it also
      // stays a plain (500) error — a genuine internal invariant.
      switch (status) {
        case 409:
          throw new ConflictError(
            ErrorCode.HAPROXY_DATAPLANE_VERSION_CONFLICT,
            `Version conflict: ${message}. Please retry with the latest version.`,
            { action: "HAProxy's configuration changed concurrently — retry the operation." },
          );
        case 404:
          throw new NotFoundError(
            ErrorCode.HAPROXY_DATAPLANE_RESOURCE_NOT_FOUND,
            `Resource not found: ${message}`,
            {
              resource: {
                type: inferHaproxyResourceType(operation),
                ...(inferHaproxyResourceName(context) !== undefined && {
                  name: inferHaproxyResourceName(context),
                }),
              },
              action: "Refresh and verify the HAProxy resource still exists.",
            },
          );
        case 401:
          throw new InternalError(`Authentication failed: ${message}`);
        case 400:
          throw new InternalError(`Bad request: ${message}`);
        default:
          throw new InternalError(`HAProxy ${operation} failed: ${message} (Status: ${status})`);
      }
    } else {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { operation, error: errorMessage, ...context },
        `HAProxy DataPlane API ${operation} failed with unexpected error`
      );

      throw new InternalError(`HAProxy ${operation} failed: ${errorMessage}`);
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
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Only retry on version conflicts
        if ((error instanceof Error ? error.message : String(error))?.includes('Version conflict') && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.debug(
            { attempt, delay, error: (error instanceof Error ? error.message : String(error)) },
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
