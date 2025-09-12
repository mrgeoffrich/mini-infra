import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class RemoveBlueFromLB {
    execute(): void {
        logger.info('Action: Removing blue backend and servers from HAProxy...');
    }
}