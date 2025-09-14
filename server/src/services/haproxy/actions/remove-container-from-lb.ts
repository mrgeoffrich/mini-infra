import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class RemoveContainerFromLB {
    execute(): void {
        logger.info('Action: Removing container backend and servers from HAProxy...');
    }
}