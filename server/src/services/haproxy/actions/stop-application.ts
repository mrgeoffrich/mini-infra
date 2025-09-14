import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class StopApplication {
    execute(): void {
        logger.info('Action: Stopping application containers...');
    }
}