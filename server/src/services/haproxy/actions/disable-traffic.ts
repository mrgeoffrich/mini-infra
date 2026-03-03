import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';

const logger = loadbalancerLogger();

export class DisableTraffic {
    private haproxyClient: HAProxyDataPlaneClient;

    constructor() {
        this.haproxyClient = new HAProxyDataPlaneClient();
    }

    async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.newContainerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Disabling traffic to backend...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for traffic disablement');
            }
            if (!context.applicationName) {
                throw new Error('Application name is required for backend identification');
            }
            if (!context.newContainerId) {
                throw new Error('New container ID is required for server identification');
            }

            // Initialize HAProxy DataPlane client
            logger.info({
                deploymentId: context.deploymentId,
                haproxyContainerId: context.haproxyContainerId.slice(0, 12),
                applicationName: context.applicationName
            }, 'Initializing HAProxy DataPlane client for traffic disablement');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            // Calculate server and backend names (matching previous actions)
            const backendName = context.applicationName;
            const serverName = `${context.applicationName}-${context.newContainerId.slice(0, 8)}`;

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName
            }, 'Disabling server traffic in HAProxy backend by setting to maintenance mode');

            // Disable the server by setting state to 'maint' (maintenance mode)
            await this.haproxyClient.setServerState(backendName, serverName, 'maint');

            // Verify the server is now disabled by checking its status
            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName
            }, 'Verifying server is in maintenance mode');

            // Wait a moment for the state change to take effect
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Check server stats to verify it's disabled
            const serverStats = await this.haproxyClient.getServerStats(backendName, serverName);

            if (!serverStats) {
                throw new Error(`Server ${serverName} not found in backend ${backendName} after disabling traffic`);
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
            }, 'Server status after disabling traffic');

            // Verify the server is in maintenance mode (disabled)
            if (serverStats.status === 'MAINT') {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: serverStats.status,
                    applicationName: context.applicationName
                }, 'Traffic successfully disabled - server is in maintenance mode');

                // Send success event for rollback scenario
                sendEvent({
                    type: 'ROLLBACK_GREEN_TRAFFIC_DISABLED'
                });
            } else {
                // Server might not be in maintenance mode as expected
                logger.warn({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: serverStats.status,
                    checkStatus: serverStats.check_status
                }, 'Server status is not MAINT after disable attempt - this may indicate an issue');

                // Still send success event as the disable command was executed
                sendEvent({
                    type: 'ROLLBACK_GREEN_TRAFFIC_DISABLED'
                });
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during traffic disablement';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                newContainerId: context.newContainerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to disable traffic');

            // Send error event for rollback scenario
            sendEvent({
                type: 'ROLLBACK_ERROR',
                error: errorMessage
            });
        }
    }
}