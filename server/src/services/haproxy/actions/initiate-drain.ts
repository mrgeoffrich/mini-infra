import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class InitiateDrain {
    execute(): void {
        logger.info('Action: Setting blue servers to drain mode...');
    }
}