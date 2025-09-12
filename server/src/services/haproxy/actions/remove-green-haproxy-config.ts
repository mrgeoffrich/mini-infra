import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class RemoveGreenHAProxyConfig {
    execute(): void {
        logger.info('Action: Removing green backend and servers from HAProxy...');
    }
}