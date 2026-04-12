import { isHttpError } from '../../../lib/http-client';
import { HAProxyBaseConstructor, ServerStats, BackendStats } from './types';

export function StatsMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
    /**
     * Get server statistics
     */
    async getServerStats(backendName: string, serverName: string): Promise<ServerStats | null> {
      try {
        const response = await this.httpClient.get(
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
        if (isHttpError(error) && error.response?.status === 404) {
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
        const response = await this.httpClient.get(
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
        if (isHttpError(error) && error.response?.status === 404) {
          return null;
        }
        this.handleApiError(error, 'get backend stats', { backendName });
        return null;
      }
    }

    /**
     * Check if server exists in runtime
     */
    async isServerInRuntime(backendName: string, serverName: string): Promise<boolean> {
      try {
        const stats = await this.getServerStats(backendName, serverName);
        return stats !== null;
      } catch {
        return false;
      }
    }
  };
}
