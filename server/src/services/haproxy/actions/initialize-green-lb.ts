import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class InitializeGreenLB {
    execute(): void {
        logger.info('Action: Creating green backend and registering servers in HAProxy...');
    }
}