import { isHttpError } from '../../../lib/http-client';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyBaseConstructor } from './types';

const logger = loadbalancerLogger();

export interface HttpRequestRule {
  index?: number;
  type: string;
  service_name?: string;
  cond?: string;
  cond_test?: string;
}

export function HttpRulesMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
    /**
     * Get all http-request rules for a frontend
     */
    async getHttpRequestRules(frontendName: string): Promise<HttpRequestRule[]> {
      try {
        const response = await this.httpClient.get(
          `/services/haproxy/configuration/frontends/${frontendName}/http_request_rules`
        );
        return response.data || [];
      } catch (error) {
        if (isHttpError(error) && error.response?.status === 404) {
          return [];
        }
        this.handleApiError(error, 'get http request rules', { frontendName });
        return [];
      }
    }

    /**
     * Idempotently ensure an http-request rule exists on a frontend.
     * Matches by type + service_name + cond + cond_test.
     * Returns true if the rule was added, false if it already existed.
     */
    async ensureHttpRequestRule(frontendName: string, rule: HttpRequestRule): Promise<boolean> {
      const existing = await this.getHttpRequestRules(frontendName);

      const alreadyPresent = existing.some(
        r =>
          r.type === rule.type &&
          r.service_name === rule.service_name &&
          r.cond === rule.cond &&
          r.cond_test === rule.cond_test
      );

      if (alreadyPresent) {
        logger.debug(
          { frontendName, rule },
          'http-request rule already present, skipping'
        );
        return false;
      }

      const version = await this.getVersion();
      const newRule: HttpRequestRule = { ...rule, index: existing.length };
      const updated = [...existing, newRule];

      await this.httpClient.put(
        `/services/haproxy/configuration/frontends/${frontendName}/http_request_rules?version=${version}&force_reload=true`,
        updated
      );

      logger.info(
        { frontendName, rule, totalRules: updated.length },
        'Added http-request rule to frontend'
      );

      return true;
    }
  };
}
