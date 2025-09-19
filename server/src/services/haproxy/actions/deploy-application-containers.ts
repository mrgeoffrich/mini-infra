import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class DeployApplicationContainers {
    execute(context?: any): void {
        logger.info('Action: Deploying application containers...', {
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            dockerImage: context?.dockerImage,
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        });
    }
}