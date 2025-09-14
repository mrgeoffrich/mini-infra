import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class OpenTraffic {
    execute(): void {
        logger.info('Action: Opening traffic to container...');
    }
}