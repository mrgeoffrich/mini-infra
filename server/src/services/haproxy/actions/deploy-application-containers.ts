import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class DeployApplicationContainers {
    execute(): void {
        logger.info('Action: Deploying application containers...');
    }
}