import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';

const logger = loadbalancerLogger();

export class RemoveContainerFromLB {
    private haproxyClient: HAProxyDataPlaneClient;

    constructor() {
        this.haproxyClient = new HAProxyDataPlaneClient();
    }

    async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Removing container backend and servers from HAProxy...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for load balancer configuration');
            }
            if (!context.applicationName) {
                throw new Error('Application name is required for backend configuration');
            }

            // Initialize HAProxy DataPlane client
            logger.info({
                deploymentId: context.deploymentId,
                haproxyContainerId: context.haproxyContainerId.slice(0, 12),
                applicationName: context.applicationName
            }, 'Initializing HAProxy DataPlane client for removal');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            const backendName = context.applicationName;

            // Check if backend exists
            const existingBackend = await this.haproxyClient.getBackend(backendName);
            if (!existingBackend) {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName
                }, 'HAProxy backend does not exist, skipping removal');

                sendEvent({
                    type: 'LB_REMOVAL_SUCCESS'
                });
                return;
            }

            // If we have a specific container ID, remove only that server
            if (context.containerId) {
                const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;

                logger.info({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName
                }, 'Removing specific server from HAProxy backend');

                // Check if server exists in runtime before attempting deletion
                const serverInRuntime = await this.haproxyClient.isServerInRuntime(backendName, serverName);
                if (serverInRuntime) {
                    await this.haproxyClient.deleteServer(backendName, serverName);
                    logger.info({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName
                    }, 'Server successfully removed from HAProxy backend');
                } else {
                    logger.info({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName
                    }, 'Server not found in HAProxy runtime, skipping server removal');
                }
            }

            // Check if backend has any remaining servers
            const backend = await this.haproxyClient.getBackend(backendName);
            if (backend && (!backend.servers || backend.servers.length === 0)) {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName
                }, 'Backend has no remaining servers - backend will be removed after frontend cleanup');
            } else {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName,
                    remainingServers: backend?.servers?.length || 0
                }, 'Backend still has servers, keeping backend configuration');
            }

            logger.info({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                backendName
            }, 'Container successfully removed from HAProxy load balancer');

            // Send success event
            sendEvent({
                type: 'LB_REMOVAL_SUCCESS'
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during HAProxy removal';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                containerId: context.containerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to remove container from HAProxy load balancer');

            // Send error event
            sendEvent({
                type: 'LB_REMOVAL_FAILED',
                error: errorMessage
            });
        }
    }
}