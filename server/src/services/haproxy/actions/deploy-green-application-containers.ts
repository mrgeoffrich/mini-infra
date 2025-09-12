import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class DeployGreenApplicationContainers {
    execute(): void {
        logger.info('Action: Deploying green application containers...');
    }
}