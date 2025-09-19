import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

export class MonitorContainerStartup {
    execute(context?: any): void {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12) || context?.newContainerId?.slice(0, 12),
        }, 'Action: Monitoring container startup...');
    }
}