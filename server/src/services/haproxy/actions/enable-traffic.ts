import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';

const logger = loadbalancerLogger();

export class EnableTraffic {
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
        }, 'Action: Enabling traffic to backend...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for traffic enablement');
            }
            if (!context.applicationName) {
                throw new Error('Application name is required for backend identification');
            }
            if (!context.containerId) {
                throw new Error('Container ID is required for server identification');
            }

            // Initialize HAProxy DataPlane client
            logger.info({
                deploymentId: context.deploymentId,
                haproxyContainerId: context.haproxyContainerId.slice(0, 12),
                applicationName: context.applicationName
            }, 'Initializing HAProxy DataPlane client for traffic enablement');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            // Calculate server and backend names (matching previous actions)
            const backendName = context.applicationName;
            const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName
            }, 'Enabling server to accept traffic in HAProxy backend');

            // Enable the server to accept traffic by setting state to 'ready'
            await this.haproxyClient.setServerState(backendName, serverName, 'ready');

            // Verify the server is now enabled by checking its status
            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName
            }, 'Verifying server is accepting traffic');

            // Wait a moment for the state change to take effect
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Check server stats to verify it's accepting traffic
            const serverStats = await this.haproxyClient.getServerStats(backendName, serverName);

            if (!serverStats) {
                throw new Error(`Server ${serverName} not found in backend ${backendName} after enabling traffic`);
            }

            // Log the current status for debugging
            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                status: serverStats.status,
                checkStatus: serverStats.check_status,
                currentSessions: serverStats.current_sessions,
                totalSessions: serverStats.total_sessions
            }, 'Server status after enabling traffic');

            // Verify the server is in a state that can accept traffic
            // The server should be UP and not in maintenance mode
            if (serverStats.status === 'UP') {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: serverStats.status,
                    applicationName: context.applicationName
                }, 'Traffic successfully enabled - server is ready to accept requests');

                // Send success event
                sendEvent({
                    type: 'TRAFFIC_ENABLED'
                });
            } else if (serverStats.status === 'MAINT') {
                throw new Error(`Server is in maintenance mode after enable attempt. Status: ${serverStats.status}`);
            } else {
                // Server might still be coming up, but traffic enablement was successful
                logger.warn({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: serverStats.status,
                    checkStatus: serverStats.check_status
                }, 'Traffic enabled but server status is not UP yet - this may be normal during startup');

                // Still consider this successful as the server state was set to ready
                sendEvent({
                    type: 'TRAFFIC_ENABLED'
                });
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during traffic enablement';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                containerId: context.containerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to enable traffic');

            // Send error event
            sendEvent({
                type: 'TRAFFIC_ENABLE_FAILED',
                error: errorMessage
            });
        }
    }
}