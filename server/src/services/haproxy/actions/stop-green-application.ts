import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class StopGreenApplication {
    execute(): void {
        logger.info('Action: Stopping green application containers...');
    }
}