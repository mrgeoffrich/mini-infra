import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { loadbalancerLogger } from '../../lib/logger-factory';
import DockerService from '../docker';

const logger = loadbalancerLogger();

// ====================
// Types and Interfaces
// ====================

export interface ServerConfig {
  name: string;
  address: string;
  port: number;
  check?: 'enabled' | 'disabled';
  check_path?: string;
  inter?: number; // health check interval in ms
  rise?: number; // number of checks to consider server up
  fall?: number; // number of checks to consider server down
  maintenance?: 'enabled' | 'disabled';
  enabled?: boolean;
  weight?: number;
}

export interface BackendConfig {
  name: string;
  mode?: 'http' | 'tcp';
  balance?: 'roundrobin' | 'leastconn' | 'source';
  check_timeout?: number;
  connect_timeout?: number;
  server_timeout?: number;
}

export interface FrontendConfig {
  name: string;
  mode?: 'http' | 'tcp';
  default_backend?: string;
  bind_port?: number;
  bind_address?: string;
}

export interface FrontendRule {
  id: number;
  type: 'use_backend' | 'redirect' | 'http-request';
  cond: 'if' | 'unless';
  cond_test: string;
  backend?: string;
  redirect_code?: number;
  redirect_value?: string;
}

export interface Backend {
  name: string;
  mode: string;
  balance: {
    algorithm: string;
  };
  servers?: Server[];
}

export interface Server {
  name: string;
  address: string;
  port: number;
  weight: number;
  enabled: boolean;
  stats: {
    status: string;
    health: string;
  };
}

export interface ServerStats {
  name: string;
  status: 'UP' | 'DOWN' | 'MAINT' | 'DRAIN';
  check_status: string;
  check_duration: number;
  weight: number;
  current_sessions: number;
  max_sessions: number;
  total_sessions: number;
  bytes_in: number;
  bytes_out: number;
  denied_requests: number;
  errors_con: number;
  errors_resp: number;
  warnings_retr: number;
  warnings_redis: number;
}

export interface BackendStats {
  name: string;
  status: string;
  current_sessions: number;
  max_sessions: number;
  total_sessions: number;
  bytes_in: number;
  bytes_out: number;
  denied_requests: number;
  errors_con: number;
  errors_resp: number;
  weight: number;
  act_servers: number;
  bck_servers: number;
}

export interface HAProxyEndpointInfo {
  baseUrl: string;
  containerName: string;
  containerId: string;
}

export interface Version {
  version: number;
}

export interface ApiResponse<T> {
  data: T;
  version?: number;
}

export interface ErrorResponse {
  code: number;
  message: string;
}

// ====================
// HAProxy DataPlane API Client
// ====================

export class HAProxyDataPlaneClient {
  private axiosInstance: AxiosInstance;
  private dockerService: DockerService;
  private endpointInfo: HAProxyEndpointInfo | null = null;
  private username = 'admin';
  private password = 'adminpwd';

  constructor() {
    this.dockerService = DockerService.getInstance();

    // Initialize axios instance with defaults
    this.axiosInstance = axios.create({
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

      // Configure axios instance with discovered endpoint
      this.axiosInstance.defaults.baseURL = this.endpointInfo.baseUrl;
      this.axiosInstance.defaults.auth = {
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
   * Discover HAProxy DataPlane API endpoint from container
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

      // Check if DataPlane API port is exposed
      const ports = containerInfo.NetworkSettings?.Ports || {};
      const dataplanePort = ports['5555/tcp'];

      if (!dataplanePort || dataplanePort.length === 0) {
        throw new Error('DataPlane API port 5555 is not exposed on HAProxy container');
      }

      // Determine the endpoint URL
      let baseUrl: string;

      // Check if port is bound to host
      const hostBinding = dataplanePort[0];
      if (hostBinding && hostBinding.HostPort) {
        // Use host binding
        const hostIp = hostBinding.HostIp || 'localhost';
        baseUrl = `http://${hostIp}:${hostBinding.HostPort}/v3`;
      } else {
        // Use container network IP
        const networks = containerInfo.NetworkSettings?.Networks || {};
        const networkNames = Object.keys(networks);

        if (networkNames.length === 0) {
          throw new Error('HAProxy container is not connected to any networks');
        }

        // Use the first non-bridge network, or bridge if that's all we have
        const preferredNetwork = networkNames.find(name => name !== 'bridge') || networkNames[0];
        const networkInfo = networks[preferredNetwork];

        if (!networkInfo?.IPAddress) {
          throw new Error(`No IP address found for HAProxy container on network ${preferredNetwork}`);
        }

        baseUrl = `http://${networkInfo.IPAddress}:5555/v3`;
      }

      return {
        baseUrl,
        containerName,
        containerId
      };
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
   * Test connection to HAProxy DataPlane API
   */
  private async testConnection(): Promise<void> {
    try {
      const response = await this.axiosInstance.get('/info');

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
      if (axios.isAxiosError(error)) {
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
      const response = await this.axiosInstance.get('/services/haproxy/configuration/version');
      // API returns plain number, not an object
      return typeof response.data === 'number' ? response.data : parseInt(response.data, 10);
    } catch (error) {
      this.handleApiError(error, 'get version');
      throw error;
    }
  }

  // ====================
  // Backend Management
  // ====================

  /**
   * Create a new backend
   */
  async createBackend(config: BackendConfig): Promise<void> {
    try {
      const version = await this.getVersion();
      const backendData = {
        name: config.name,
        mode: config.mode || 'http',
        balance: {
          algorithm: config.balance || 'roundrobin'
        },
        ...(config.check_timeout && { check_timeout: config.check_timeout }),
        ...(config.connect_timeout && { connect_timeout: config.connect_timeout }),
        ...(config.server_timeout && { server_timeout: config.server_timeout })
      };

      await this.axiosInstance.post(`/services/haproxy/configuration/backends?version=${version}`, backendData);

      logger.info(
        { backendName: config.name, mode: config.mode, version },
        'Created HAProxy backend successfully'
      );
    } catch (error) {
      this.handleApiError(error, 'create backend', { backendName: config.name });
    }
  }

  /**
   * Delete a backend
   */
  async deleteBackend(name: string): Promise<void> {
    try {
      const version = await this.getVersion();
      await this.axiosInstance.delete(`/services/haproxy/configuration/backends/${name}?version=${version}`);

      logger.info(
        { backendName: name, version },
        'Deleted HAProxy backend successfully'
      );
    } catch (error) {
      this.handleApiError(error, 'delete backend', { backendName: name });
    }
  }

  /**
   * Get backend configuration
   */
  async getBackend(name: string): Promise<Backend | null> {
    try {
      const response = await this.axiosInstance.get(`/services/haproxy/configuration/backends/${name}`);
      // Handle both direct object and wrapped response formats
      return response.data.data || response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      this.handleApiError(error, 'get backend', { backendName: name });
      return null;
    }
  }

  /**
   * List all backends
   */
  async listBackends(): Promise<Backend[]> {
    try {
      const response = await this.axiosInstance.get('/services/haproxy/configuration/backends');
      // API returns direct array, not wrapped in data property
      return Array.isArray(response.data) ? response.data : (response.data.data || []);
    } catch (error) {
      // Log the error but don't throw - return empty array instead
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        logger.error({
          operation: 'list backends',
          status,
          message,
          url: error.config?.url
        }, 'HAProxy DataPlane API list backends failed');
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({
          operation: 'list backends',
          error: errorMessage
        }, 'HAProxy DataPlane API list backends failed with unexpected error');
      }
      return [];
    }
  }

  // ====================
  // Server Management
  // ====================

  /**
   * Add server to backend
   */
  async addServer(backendName: string, config: ServerConfig): Promise<void> {
    try {
      const version = await this.getVersion();
      const serverData = {
        name: config.name,
        address: config.address,
        port: config.port,
        ...(config.check && { check: config.check }),
        ...(config.check_path && { check_path: config.check_path }),
        ...(config.inter && { inter: config.inter }),
        ...(config.rise && { rise: config.rise }),
        ...(config.fall && { fall: config.fall }),
        ...(config.weight && { weight: config.weight }),
        maintenance: config.maintenance || 'disabled',
        enabled: config.enabled !== false // default to true
      };

      await this.axiosInstance.post(
        `/services/haproxy/configuration/backends/${backendName}/servers?version=${version}`,
        serverData
      );

      logger.info(
        {
          backendName,
          serverName: config.name,
          address: config.address,
          port: config.port,
          enabled: serverData.enabled,
          version
        },
        'Added server to HAProxy backend successfully'
      );
    } catch (error) {
      this.handleApiError(error, 'add server', {
        backendName,
        serverName: config.name
      });
    }
  }

  /**
   * Enable server in backend
   */
  async enableServer(backendName: string, serverName: string): Promise<void> {
    try {
      await this.axiosInstance.put(
        `/services/haproxy/runtime/servers/${backendName}/${serverName}`,
        { admin_state: 'ready' }
      );

      logger.info(
        { backendName, serverName },
        'Enabled server in HAProxy backend'
      );
    } catch (error) {
      this.handleApiError(error, 'enable server', { backendName, serverName });
    }
  }

  /**
   * Disable server in backend
   */
  async disableServer(backendName: string, serverName: string): Promise<void> {
    try {
      await this.axiosInstance.put(
        `/services/haproxy/runtime/servers/${backendName}/${serverName}`,
        { admin_state: 'maint' }
      );

      logger.info(
        { backendName, serverName },
        'Disabled server in HAProxy backend'
      );
    } catch (error) {
      this.handleApiError(error, 'disable server', { backendName, serverName });
    }
  }

  /**
   * Set server state (ready, maint, drain)
   */
  async setServerState(backendName: string, serverName: string, state: 'ready' | 'maint' | 'drain'): Promise<void> {
    try {
      await this.axiosInstance.put(
        `/services/haproxy/runtime/servers/${backendName}/${serverName}`,
        { admin_state: state }
      );

      logger.info(
        { backendName, serverName, state },
        'Set server state in HAProxy backend'
      );
    } catch (error) {
      this.handleApiError(error, 'set server state', { backendName, serverName, state });
    }
  }

  /**
   * Delete server from backend
   */
  async deleteServer(backendName: string, serverName: string): Promise<void> {
    try {
      const version = await this.getVersion();
      await this.axiosInstance.delete(
        `/services/haproxy/configuration/backends/${backendName}/servers/${serverName}?version=${version}`
      );

      logger.info(
        { backendName, serverName, version },
        'Deleted server from HAProxy backend'
      );
    } catch (error) {
      this.handleApiError(error, 'delete server', { backendName, serverName });
    }
  }

  // ====================
  // Frontend Management
  // ====================

  /**
   * Create a new frontend
   */
  async createFrontend(config: FrontendConfig): Promise<void> {
    try {
      const version = await this.getVersion();
      const frontendData = {
        name: config.name,
        mode: config.mode || 'http',
        ...(config.default_backend && { default_backend: config.default_backend })
      };

      await this.axiosInstance.post(`/services/haproxy/configuration/frontends?version=${version}`, frontendData);

      logger.info(
        { frontendName: config.name, mode: config.mode, version },
        'Created HAProxy frontend successfully'
      );
    } catch (error) {
      this.handleApiError(error, 'create frontend', { frontendName: config.name });
    }
  }

  /**
   * Add bind to frontend
   */
  async addFrontendBind(frontendName: string, address: string, port: number): Promise<void> {
    try {
      const version = await this.getVersion();
      const bindData = {
        name: `bind_${port}`,
        address,
        port
      };

      await this.axiosInstance.post(
        `/services/haproxy/configuration/frontends/${frontendName}/binds?version=${version}`,
        bindData
      );

      logger.info(
        { frontendName, address, port, version },
        'Added bind to HAProxy frontend'
      );
    } catch (error) {
      this.handleApiError(error, 'add frontend bind', { frontendName, address, port });
    }
  }

  // ====================
  // Stats and Monitoring
  // ====================

  /**
   * Get server statistics
   */
  async getServerStats(backendName: string, serverName: string): Promise<ServerStats | null> {
    try {
      const response = await this.axiosInstance.get(
        `/services/haproxy/stats/native?type=server&name=${backendName}/${serverName}`
      );

      const stats = response.data?.[0];
      if (!stats) {
        return null;
      }

      return {
        name: stats.svname,
        status: stats.status,
        check_status: stats.check_status,
        check_duration: stats.check_duration,
        weight: stats.weight,
        current_sessions: stats.scur,
        max_sessions: stats.smax,
        total_sessions: stats.stot,
        bytes_in: stats.bin,
        bytes_out: stats.bout,
        denied_requests: stats.dreq,
        errors_con: stats.econ,
        errors_resp: stats.eresp,
        warnings_retr: stats.wretr,
        warnings_redis: stats.wredis
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      this.handleApiError(error, 'get server stats', { backendName, serverName });
      return null;
    }
  }

  /**
   * Get backend statistics
   */
  async getBackendStats(backendName: string): Promise<BackendStats | null> {
    try {
      const response = await this.axiosInstance.get(
        `/services/haproxy/stats/native?type=backend&name=${backendName}`
      );

      const stats = response.data?.[0];
      if (!stats) {
        return null;
      }

      return {
        name: stats.pxname,
        status: stats.status,
        current_sessions: stats.scur,
        max_sessions: stats.smax,
        total_sessions: stats.stot,
        bytes_in: stats.bin,
        bytes_out: stats.bout,
        denied_requests: stats.dreq,
        errors_con: stats.econ,
        errors_resp: stats.eresp,
        weight: stats.weight,
        act_servers: stats.act,
        bck_servers: stats.bck
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      this.handleApiError(error, 'get backend stats', { backendName });
      return null;
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
      const response = await this.axiosInstance.post(`/services/haproxy/transactions?version=${version}`, {
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
      await this.axiosInstance.put(`/services/haproxy/transactions/${transactionId}`, {
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
      await this.axiosInstance.delete(`/services/haproxy/transactions/${transactionId}`);

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
  private handleApiError(error: unknown, operation: string, context?: Record<string, any>): void {
    if (axios.isAxiosError(error)) {
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
  protected async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
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

// ====================
// Transaction Manager for Atomic Operations
// ====================

export class TransactionManager {
  constructor(private client: HAProxyDataPlaneClient) {}

  /**
   * Execute multiple operations atomically within a transaction
   */
  async executeInTransaction<T>(
    operations: (transactionId: string) => Promise<T>
  ): Promise<T> {
    const transaction = await this.client.beginTransaction();

    try {
      const result = await operations(transaction);
      await this.client.commitTransaction(transaction);
      return result;
    } catch (error) {
      await this.client.rollbackTransaction(transaction);
      throw error;
    }
  }

  /**
   * Helper method to add transaction_id to requests
   */
  withTransaction(transactionId: string, url: string): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}transaction_id=${transactionId}`;
  }
}

// ====================
// Retryable HAProxy Client with Exponential Backoff
// ====================

export class RetryableHAProxyClient extends HAProxyDataPlaneClient {
  private maxRetries = 3;
  private baseDelay = 1000;

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
  async addFrontendBind(frontendName: string, address: string, port: number): Promise<void> {
    return this.withRetry(() => super.addFrontendBind(frontendName, address, port));
  }
}

export default HAProxyDataPlaneClient;