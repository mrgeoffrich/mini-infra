import { isHttpError } from '../../../lib/http-client';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyBaseConstructor } from './types';

const logger = loadbalancerLogger();

export function SwitchingRulesMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
    /**
     * Get all backend switching rules for a frontend
     */
    async getBackendSwitchingRules(frontendName: string): Promise<any[]> {
      try {
        const response = await this.httpClient.get(
          `/services/haproxy/configuration/frontends/${frontendName}/backend_switching_rules`
        );

        return response.data || [];
      } catch (error) {
        if (isHttpError(error) && error.response?.status === 404) {
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
        const existingRule = existingRules.find((rule: { cond?: string; cond_test?: string; name?: string; rule_index?: number }) =>
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
        await this.httpClient.put(
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
     * Update a backend switching rule by index
     */
    async updateBackendSwitchingRule(frontendName: string, index: number, rule: Record<string, unknown>): Promise<void> {
      try {
        const version = await this.getVersion();
        await this.httpClient.put(
          `/services/haproxy/configuration/frontends/${frontendName}/backend_switching_rules/${index}?version=${version}`,
          { index, ...rule }
        );

        logger.info(
          { frontendName, index, version },
          'Updated backend switching rule successfully'
        );
      } catch (error) {
        this.handleApiError(error, 'update backend switching rule', { frontendName, index });
      }
    }

    /**
     * Delete a backend switching rule from a frontend by index
     */
    async deleteBackendSwitchingRule(frontendName: string, index: number): Promise<void> {
      try {
        const version = await this.getVersion();
        await this.httpClient.delete(
          `/services/haproxy/configuration/frontends/${frontendName}/backend_switching_rules/${index}?version=${version}`
        );

        logger.info(
          { frontendName, index, version },
          'Deleted backend switching rule from frontend successfully'
        );
      } catch (error) {
        if (isHttpError(error) && error.response?.status === 404) {
          logger.warn({ frontendName, index }, 'Backend switching rule not found, already deleted');
          return;
        }
        this.handleApiError(error, 'delete backend switching rule', { frontendName, index });
      }
    }
  };
}
