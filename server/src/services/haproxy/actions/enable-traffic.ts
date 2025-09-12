import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class EnableTraffic {
    execute(): void {
        logger.info('Action: Enabling traffic to backend...');
    }
}