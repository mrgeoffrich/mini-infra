import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class StopBlueApplication {
    execute(): void {
        logger.info('Action: Stopping blue application containers...');
    }
}