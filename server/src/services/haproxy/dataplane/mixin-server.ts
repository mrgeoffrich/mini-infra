import { isHttpError } from '../../../lib/http-client';
import { getLogger } from '../../../lib/logger-factory';
import { HAProxyBaseConstructor, ServerConfig, Server } from './types';

const logger = getLogger("haproxy", "mixin-server");

export function ServerMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
    /**
     * Add server to backend
     */
    async addServer(backendName: string, config: ServerConfig): Promise<void> {
      await this.addServerInternal(backendName, config, true);
    }

    /**
     * Internal method to add server with optional transaction management
     */
    async addServerInternal(backendName: string, config: ServerConfig, useTransaction: boolean = true): Promise<void> {
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
          await this.httpClient.post(
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
          await this.httpClient.post(
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
        await this.httpClient.put(
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
        await this.httpClient.put(
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
        await this.httpClient.put(
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
     * Update server runtime state (weight, admin_state, operational_state)
     */
    async updateServerRuntime(backendName: string, serverName: string, updates: Record<string, unknown>): Promise<void> {
      try {
        await this.httpClient.put(
          `/services/haproxy/runtime/backends/${backendName}/servers/${serverName}`,
          updates
        );

        logger.info(
          { backendName, serverName, updates },
          'Updated server runtime state in HAProxy backend'
        );
      } catch (error) {
        this.handleApiError(error, 'update server runtime', { backendName, serverName });
      }
    }

    /**
     * List all servers in a backend
     */
    async listServers(backendName: string): Promise<Server[]> {
      try {
        const response = await this.httpClient.get(
          `/services/haproxy/configuration/backends/${backendName}/servers`
        );
        return Array.isArray(response.data) ? response.data : [];
      } catch (error) {
        if (isHttpError(error) && error.response?.status === 404) {
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
        await this.httpClient.delete(
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
  };
}
