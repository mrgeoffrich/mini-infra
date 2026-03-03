import axios from 'axios';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyBaseConstructor, BackendConfig, Backend } from './types';

const logger = loadbalancerLogger();

export function BackendMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
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
  };
}
