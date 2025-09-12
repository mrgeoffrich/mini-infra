import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class LogDeploymentSuccess {
    execute(): void {
        logger.info('Action: Logging deployment success and updating history...');
    }
}