import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class RemoveBlueApplication {
    execute(): void {
        logger.info('Action: Removing blue application containers and resources...');
    }
}