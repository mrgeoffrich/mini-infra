import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class DisableGreenTraffic {
    execute(): void {
        logger.info('Action: Disabling traffic to green backend...');
    }
}