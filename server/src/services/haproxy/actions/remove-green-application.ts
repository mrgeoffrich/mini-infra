import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class RemoveGreenApplication {
    execute(): void {
        logger.info('Action: Removing green application containers and resources...');
    }
}