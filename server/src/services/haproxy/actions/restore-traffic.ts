import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class RestoreTraffic {
    execute(): void {
        logger.info('Action: Restoring all traffic to blue backend...');
    }
}