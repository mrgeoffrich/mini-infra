import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class DisableTraffic {
    execute(): void {
        logger.info('Action: Disabling traffic to backend...');
    }
}