import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class AddContainerToLB {
    execute(): void {
        logger.info('Action: Adding container backend and servers to HAProxy...');
    }
}