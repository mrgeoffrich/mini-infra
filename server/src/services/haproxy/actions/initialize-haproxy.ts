import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class InitializeHAProxy {
    execute(): void {
        logger.info('Action: Initializing HAProxy and creating backend...');
    }
}