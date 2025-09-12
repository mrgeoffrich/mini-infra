import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class PerformHealthChecks {
    execute(): void {
        logger.info('Action: Performing health checks on servers...');
    }
}