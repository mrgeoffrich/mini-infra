import axios from 'axios';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyBaseConstructor } from './types';

const logger = loadbalancerLogger();

export function ACLMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
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
  };
}
