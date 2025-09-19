import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class EnableTraffic {
    execute(context?: any): void {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12) || context?.newContainerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Enabling traffic to backend...');
    }
}