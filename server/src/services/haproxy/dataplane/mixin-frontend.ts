import { isHttpError } from '../../../lib/http-client';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyBaseConstructor, FrontendConfig } from './types';

const logger = loadbalancerLogger();

export function FrontendMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
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

        await this.httpClient.post(`/services/haproxy/configuration/frontends?version=${version}`, frontendData);

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
        const bindData: Record<string, unknown> = {
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

        await this.httpClient.post(
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
        await this.httpClient.delete(`/services/haproxy/configuration/frontends/${name}?version=${version}`);

        logger.info(
          { frontendName: name, version },
          'Deleted HAProxy frontend successfully'
        );
      } catch (error) {
        this.handleApiError(error, 'delete frontend', { frontendName: name });
      }
    }

    /**
     * Get frontend configuration
     */
    async getFrontend(name: string): Promise<any | null> {
      try {
        const response = await this.httpClient.get(`/services/haproxy/configuration/frontends/${name}`);
        return response.data.data || response.data;
      } catch (error) {
        if (isHttpError(error) && error.response?.status === 404) {
          return null;
        }
        this.handleApiError(error, 'get frontend', { frontendName: name });
        return null;
      }
    }

    /**
     * Delete a bind from a frontend
     */
    async deleteFrontendBind(frontendName: string, bindName: string): Promise<void> {
      try {
        const version = await this.getVersion();
        await this.httpClient.delete(
          `/services/haproxy/configuration/frontends/${frontendName}/binds/${bindName}?version=${version}`
        );

        logger.info(
          { frontendName, bindName, version },
          'Deleted bind from HAProxy frontend'
        );
      } catch (error) {
        this.handleApiError(error, 'delete frontend bind', { frontendName, bindName });
      }
    }
  };
}
