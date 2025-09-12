import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class AlertOperationsTeam {
    execute(): void {
        logger.info('Action: Alerting operations team of failure...');
    }
}