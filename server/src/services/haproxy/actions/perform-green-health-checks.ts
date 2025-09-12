import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class PerformGreenHealthChecks {
    execute(): void {
        logger.info('Action: Performing health checks on green servers...');
    }
}