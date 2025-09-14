import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class RemoveHAProxyConfig {
    execute(): void {
        logger.info('Action: Removing backend and servers from HAProxy...');
    }
}