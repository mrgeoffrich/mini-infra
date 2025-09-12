import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class OpenTrafficToGreen {
    execute(): void {
        logger.info('Action: Opening traffic to green backend alongside blue...');
    }
}