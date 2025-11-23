import axios, { AxiosInstance, AxiosResponse } from 'axios';
import FormData from 'form-data';
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
        // Use host binding (0.0.0.0 means "all interfaces" for binding, but we need localhost to connect)
        const hostIp = (hostBinding.HostIp && hostBinding.HostIp !== '0.0.0.0') ? hostBinding.HostIp : 'localhost';
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
    await this.addServerInternal(backendName, config, true);
  }

  /**
   * Internal method to add server with optional transaction management
   */
  private async addServerInternal(backendName: string, config: ServerConfig, useTransaction: boolean = true): Promise<void> {
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

    if (useTransaction) {
      // Use transaction to ensure server is properly committed to runtime
      const transaction = await this.beginTransaction();

      try {
        await this.axiosInstance.post(
          `/services/haproxy/configuration/backends/${backendName}/servers?transaction_id=${transaction}`,
          serverData
        );

        // Commit the transaction to apply changes to runtime
        await this.commitTransaction(transaction);

        logger.info(
          {
            backendName,
            serverName: config.name,
            address: config.address,
            port: config.port,
            enabled: serverData.enabled,
            transaction
          },
          'Added server to HAProxy backend successfully via transaction'
        );

        // Wait a moment for the committed changes to be available in runtime
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        await this.rollbackTransaction(transaction);
        this.handleApiError(error, 'add server', {
          backendName,
          serverName: config.name
        });
      }
    } else {
      // Use version-based approach (for use within external transactions)
      try {
        const version = await this.getVersion();
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
          'Added server to HAProxy backend successfully with version'
        );
      } catch (error) {
        this.handleApiError(error, 'add server', {
          backendName,
          serverName: config.name
        });
      }
    }
  }

  /**
   * Enable server in backend
   */
  async enableServer(backendName: string, serverName: string): Promise<void> {
    try {
      await this.axiosInstance.put(
        `/services/haproxy/runtime/backends/${backendName}/servers/${serverName}`,
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
        `/services/haproxy/runtime/backends/${backendName}/servers/${serverName}`,
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
        `/services/haproxy/runtime/backends/${backendName}/servers/${serverName}`,
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
   * Check if server exists in runtime
   */
  async isServerInRuntime(backendName: string, serverName: string): Promise<boolean> {
    try {
      const stats = await this.getServerStats(backendName, serverName);
      return stats !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * List all servers in a backend
   */
  async listServers(backendName: string): Promise<Server[]> {
    try {
      const response = await this.axiosInstance.get(
        `/services/haproxy/configuration/backends/${backendName}/servers`
      );
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return [];
      }
      this.handleApiError(error, 'list servers', { backendName });
      return [];
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
  async addFrontendBind(frontendName: string, address: string, port: number, sslOptions?: { ssl?: boolean; ssl_certificate?: string }): Promise<void> {
    try {
      const version = await this.getVersion();
      const bindData: any = {
        name: `bind_${port}`,
        address,
        port
      };

      // Add SSL options if provided
      if (sslOptions?.ssl) {
        bindData.ssl = true;
        if (sslOptions.ssl_certificate) {
          bindData.ssl_certificate = sslOptions.ssl_certificate;
        }
      }

      await this.axiosInstance.post(
        `/services/haproxy/configuration/frontends/${frontendName}/binds?version=${version}`,
        bindData
      );

      logger.info(
        { frontendName, address, port, ssl: sslOptions?.ssl, version },
        'Added bind to HAProxy frontend'
      );
    } catch (error) {
      this.handleApiError(error, 'add frontend bind', { frontendName, address, port });
    }
  }

  /**
   * Delete a frontend
   */
  async deleteFrontend(name: string): Promise<void> {
    try {
      const version = await this.getVersion();
      await this.axiosInstance.delete(`/services/haproxy/configuration/frontends/${name}?version=${version}`);

      logger.info(
        { frontendName: name, version },
        'Deleted HAProxy frontend successfully'
      );
    } catch (error) {
      this.handleApiError(error, 'delete frontend', { frontendName: name });
    }
  }

  // ====================
  // ACL Management
  // ====================

  /**
   * Get all ACLs for a frontend
   */
  async getACLs(frontendName: string): Promise<any[]> {
    try {
      const response = await this.axiosInstance.get(
        `/services/haproxy/configuration/frontends/${frontendName}/acls`
      );

      return response.data || [];
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return [];
      }
      this.handleApiError(error, 'get ACLs', { frontendName });
      return [];
    }
  }

  /**
   * Add an ACL to a frontend using PUT with automatic index tracking
   * Note: HAProxy DataPlane API requires replacing the entire ACL list
   *
   * @param frontendName The frontend to add ACL to
   * @param aclName The name of the ACL
   * @param criterion The ACL criterion (e.g., "hdr(host)")
   * @param value The value to match (e.g., "-i example.com")
   */
  async addACL(
    frontendName: string,
    aclName: string,
    criterion: string,
    value: string
  ): Promise<void> {
    try {
      const version = await this.getVersion();

      // Get existing ACLs
      const existingACLs = await this.getACLs(frontendName);

      // Check if ACL already exists
      const existingACL = existingACLs.find((acl: any) => acl.acl_name === aclName);
      if (existingACL) {
        logger.warn(
          { frontendName, aclName },
          'ACL already exists, skipping'
        );
        return;
      }

      // Add new ACL to the list
      const newACL = {
        acl_name: aclName,
        criterion: criterion,
        value: value
      };
      const updatedACLs = [...existingACLs, newACL];

      // Replace the entire ACL list
      await this.axiosInstance.put(
        `/services/haproxy/configuration/frontends/${frontendName}/acls?version=${version}&force_reload=true`,
        updatedACLs
      );

      logger.info(
        { frontendName, aclName, criterion, value, totalACLs: updatedACLs.length, version },
        'Added ACL to frontend successfully'
      );
    } catch (error) {
      this.handleApiError(error, 'add ACL', { frontendName, aclName });
    }
  }

  /**
   * Delete an ACL from a frontend by index
   */
  async deleteACL(frontendName: string, index: number): Promise<void> {
    try {
      const version = await this.getVersion();
      await this.axiosInstance.delete(
        `/services/haproxy/configuration/frontends/${frontendName}/acls/${index}?version=${version}`
      );

      logger.info(
        { frontendName, index, version },
        'Deleted ACL from frontend successfully'
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        logger.warn({ frontendName, index }, 'ACL not found, already deleted');
        return;
      }
      this.handleApiError(error, 'delete ACL', { frontendName, index });
    }
  }

  // ====================
  // Backend Switching Rules
  // ====================

  /**
   * Get all backend switching rules for a frontend
   */
  async getBackendSwitchingRules(frontendName: string): Promise<any[]> {
    try {
      const response = await this.axiosInstance.get(
        `/services/haproxy/configuration/frontends/${frontendName}/backend_switching_rules`
      );

      return response.data || [];
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return [];
      }
      this.handleApiError(error, 'get backend switching rules', { frontendName });
      return [];
    }
  }

  /**
   * Add a backend switching rule to a frontend with automatic index tracking
   * Note: HAProxy DataPlane API requires replacing the entire rule list
   *
   * @param frontendName The frontend to add the rule to
   * @param backendName The backend to route to
   * @param aclName The ACL name to use in the condition
   * @param condition The condition type ('if' or 'unless')
   */
  async addBackendSwitchingRule(
    frontendName: string,
    backendName: string,
    aclName: string,
    condition: 'if' | 'unless' = 'if'
  ): Promise<void> {
    try {
      const version = await this.getVersion();

      // Get existing rules
      const existingRules = await this.getBackendSwitchingRules(frontendName);

      // Check if rule already exists
      const existingRule = existingRules.find((rule: any) =>
        rule.cond_test === aclName && rule.name === backendName
      );
      if (existingRule) {
        logger.warn(
          { frontendName, backendName, aclName },
          'Backend switching rule already exists, skipping'
        );
        return;
      }

      // Add new rule to the list
      const nextIndex = existingRules.length;
      const newRule = {
        index: nextIndex,
        name: backendName,
        cond: condition,
        cond_test: aclName
      };
      const updatedRules = [...existingRules, newRule];

      // Replace the entire rule list
      await this.axiosInstance.put(
        `/services/haproxy/configuration/frontends/${frontendName}/backend_switching_rules?version=${version}&force_reload=true`,
        updatedRules
      );

      logger.info(
        { frontendName, backendName, aclName, condition, index: nextIndex, totalRules: updatedRules.length, version },
        'Added backend switching rule to frontend successfully'
      );
    } catch (error) {
      this.handleApiError(error, 'add backend switching rule', { frontendName, backendName, aclName });
    }
  }

  /**
   * Delete a backend switching rule from a frontend by index
   */
  async deleteBackendSwitchingRule(frontendName: string, index: number): Promise<void> {
    try {
      const version = await this.getVersion();
      await this.axiosInstance.delete(
        `/services/haproxy/configuration/frontends/${frontendName}/backend_switching_rules/${index}?version=${version}`
      );

      logger.info(
        { frontendName, index, version },
        'Deleted backend switching rule from frontend successfully'
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        logger.warn({ frontendName, index }, 'Backend switching rule not found, already deleted');
        return;
      }
      this.handleApiError(error, 'delete backend switching rule', { frontendName, index });
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
        `/services/haproxy/stats/native?type=server&parent=${backendName}&name=${serverName}`
      );

      const statsArray = response.data?.stats;
      if (!statsArray || statsArray.length === 0) {
        return null;
      }

      const stats = statsArray[0].stats;
      if (!stats) {
        return null;
      }

      return {
        name: statsArray[0].name,
        status: stats.status,
        check_status: stats.check_status || '',
        check_duration: stats.check_duration || 0,
        weight: stats.weight || 0,
        current_sessions: stats.scur || 0,
        max_sessions: stats.smax || 0,
        total_sessions: stats.stot || 0,
        bytes_in: stats.bin || 0,
        bytes_out: stats.bout || 0,
        denied_requests: stats.dreq || 0,
        errors_con: stats.econ || 0,
        errors_resp: stats.eresp || 0,
        warnings_retr: stats.wretr || 0,
        warnings_redis: stats.wredis || 0
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

      const statsArray = response.data?.stats;
      if (!statsArray || statsArray.length === 0) {
        return null;
      }

      const stats = statsArray[0].stats;
      if (!stats) {
        return null;
      }

      return {
        name: statsArray[0].name,
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

  // ====================
  // SSL Certificate Management
  // ====================

  /**
   * Upload a new SSL certificate to HAProxy storage
   *
   * @param filename - Certificate filename (e.g., "example.com.pem")
   * @param certificatePem - Combined PEM content (certificate + private key)
   * @param forceReload - Whether to force HAProxy reload (default: false, uses Runtime API)
   * @returns Success indicator
   */
  async uploadSSLCertificate(
    filename: string,
    certificatePem: string,
    forceReload: boolean = false
  ): Promise<void> {
    try {
      logger.info({ filename, forceReload }, 'Uploading SSL certificate via DataPlane API');

      // Create FormData for multipart/form-data upload
      const formData = new FormData();
      formData.append('file_upload', Buffer.from(certificatePem), {
        filename: filename,
        contentType: 'application/x-pem-file'
      });

      // POST to storage/ssl_certificates endpoint
      await this.axiosInstance.post(
        `/services/haproxy/storage/ssl_certificates`,
        formData,
        {
          params: {
            force_reload: forceReload.toString()
          },
          headers: {
            ...formData.getHeaders()
          }
        }
      );

      logger.info({ filename }, 'SSL certificate uploaded successfully');
    } catch (error) {
      this.handleApiError(error, 'upload SSL certificate', { filename });
      throw error;
    }
  }

  /**
   * Update an existing SSL certificate in HAProxy storage
   *
   * @param filename - Certificate filename (e.g., "example.com.pem")
   * @param certificatePem - Combined PEM content (certificate + private key)
   * @param forceReload - Whether to force HAProxy reload (default: false, uses Runtime API)
   * @returns Success indicator
   */
  async updateSSLCertificate(
    filename: string,
    certificatePem: string,
    forceReload: boolean = false
  ): Promise<void> {
    try {
      logger.info({ filename, forceReload }, 'Updating SSL certificate via DataPlane API');

      // Create FormData for multipart/form-data upload
      const formData = new FormData();
      formData.append('file_upload', Buffer.from(certificatePem), {
        filename: filename,
        contentType: 'application/x-pem-file'
      });

      // PUT to storage/ssl_certificates/{filename} endpoint
      await this.axiosInstance.put(
        `/services/haproxy/storage/ssl_certificates/${filename}`,
        formData,
        {
          params: {
            force_reload: forceReload.toString()
          },
          headers: {
            ...formData.getHeaders()
          }
        }
      );

      logger.info({ filename }, 'SSL certificate updated successfully');
    } catch (error) {
      this.handleApiError(error, 'update SSL certificate', { filename });
      throw error;
    }
  }

  /**
   * Delete an SSL certificate from HAProxy storage
   *
   * @param filename - Certificate filename (e.g., "example.com.pem")
   * @param forceReload - Whether to force HAProxy reload (default: true for deletions)
   * @returns Success indicator
   */
  async deleteSSLCertificate(
    filename: string,
    forceReload: boolean = true
  ): Promise<void> {
    try {
      logger.info({ filename, forceReload }, 'Deleting SSL certificate via DataPlane API');

      // DELETE storage/ssl_certificates/{filename} endpoint
      await this.axiosInstance.delete(
        `/services/haproxy/storage/ssl_certificates/${filename}`,
        {
          params: {
            force_reload: forceReload.toString()
          }
        }
      );

      logger.info({ filename }, 'SSL certificate deleted successfully');
    } catch (error) {
      this.handleApiError(error, 'delete SSL certificate', { filename });
      throw error;
    }
  }

  /**
   * List all SSL certificates in HAProxy storage
   *
   * @returns Array of certificate filenames
   */
  async listSSLCertificates(): Promise<string[]> {
    try {
      logger.debug('Listing SSL certificates via DataPlane API');

      const response = await this.axiosInstance.get(
        `/services/haproxy/storage/ssl_certificates`
      );

      const certificates = response.data?.data || [];
      logger.debug({ count: certificates.length }, 'SSL certificates listed');

      return certificates;
    } catch (error) {
      this.handleApiError(error, 'list SSL certificates', {});
      return [];
    }
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
    operations: () => Promise<T>
  ): Promise<T> {
    const transaction = await this.client.beginTransaction();

    try {
      // Override the axios instance to include transaction_id in all requests
      const originalGet = this.client['axiosInstance'].get;
      const originalPost = this.client['axiosInstance'].post;
      const originalPut = this.client['axiosInstance'].put;
      const originalDelete = this.client['axiosInstance'].delete;
      const originalAddServer = this.client.addServer;

      // Override addServer to use non-transactional version
      this.client.addServer = (backendName: string, config: ServerConfig) => {
        return (this.client as any).addServerInternal(backendName, config, false);
      };

      // Add transaction_id to all requests, but skip transaction-related endpoints
      (this.client['axiosInstance'].get as any) = (url: string, config?: any) => {
        return originalGet.call(this.client['axiosInstance'], this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, config);
      };

      (this.client['axiosInstance'].post as any) = (url: string, data?: any, config?: any) => {
        return originalPost.call(this.client['axiosInstance'], this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, data, config);
      };

      (this.client['axiosInstance'].put as any) = (url: string, data?: any, config?: any) => {
        return originalPut.call(this.client['axiosInstance'], this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, data, config);
      };

      (this.client['axiosInstance'].delete as any) = (url: string, config?: any) => {
        return originalDelete.call(this.client['axiosInstance'], this.shouldUseTransaction(url) ? this.withTransaction(transaction, url) : url, config);
      };

      try {
        const result = await operations();
        await this.client.commitTransaction(transaction);
        return result;
      } finally {
        // Restore original methods
        this.client['axiosInstance'].get = originalGet;
        this.client['axiosInstance'].post = originalPost;
        this.client['axiosInstance'].put = originalPut;
        this.client['axiosInstance'].delete = originalDelete;
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
  async addFrontendBind(frontendName: string, address: string, port: number, sslOptions?: { ssl?: boolean; ssl_certificate?: string }): Promise<void> {
    return this.withRetry(() => super.addFrontendBind(frontendName, address, port, sslOptions));
  }
}

export default HAProxyDataPlaneClient;