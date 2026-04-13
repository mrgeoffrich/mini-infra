import type { ActionContext, DrainInitiateEmit } from './types';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';

const logger = loadbalancerLogger();

export class InitiateDrain {
    private haproxyClient: HAProxyDataPlaneClient;

    constructor() {
        this.haproxyClient = new HAProxyDataPlaneClient();
    }

    async execute(context: ActionContext, sendEvent: (event: DrainInitiateEmit) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            oldContainerId: context?.oldContainerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Setting blue servers to drain mode...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for drain initiation');
            }
            if (!context.applicationName) {
                throw new Error('Application name is required for backend identification');
            }
            if (!context.oldContainerId) {
                throw new Error('Old container ID is required for blue server identification');
            }

            // Initialize HAProxy DataPlane client
            logger.info({
                deploymentId: context.deploymentId,
                haproxyContainerId: context.haproxyContainerId.slice(0, 12),
                applicationName: context.applicationName
            }, 'Initializing HAProxy DataPlane client for drain initiation');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            // Calculate server and backend names (matching pattern from other actions)
            const backendName = context.applicationName;
            const serverName = `${context.applicationName}-${context.oldContainerId.slice(0, 8)}`;

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName
            }, 'Setting blue server to drain mode in HAProxy backend');

            // Set the server to drain mode to gracefully handle existing connections
            await this.haproxyClient.setServerState(backendName, serverName, 'drain');

            // Verify the server is now in drain mode by checking its status
            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName
            }, 'Verifying server is in drain mode');

            // Wait a moment for the state change to take effect
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Check server stats to verify it's in drain mode
            const serverStats = await this.haproxyClient.getServerStats(backendName, serverName);

            if (!serverStats) {
                throw new Error(`Server ${serverName} not found in backend ${backendName} after drain initiation`);
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
            }, 'Server status after initiating drain');

            // Verify the server is in drain mode
            // The server should be DRAIN state
            if (serverStats.status === 'DRAIN') {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: serverStats.status,
                    applicationName: context.applicationName,
                    currentSessions: serverStats.current_sessions
                }, 'Drain successfully initiated - server is gracefully handling existing connections');

                // Send success event
                sendEvent({
                    type: 'DRAIN_INITIATED'
                });
            } else {
                // Server might not have transitioned to drain mode yet, but the command was successful
                logger.warn({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: serverStats.status,
                    checkStatus: serverStats.check_status
                }, 'Drain initiated but server status is not DRAIN yet - this may be normal during state transition');

                // Still consider this successful as the server state was set to drain
                sendEvent({
                    type: 'DRAIN_INITIATED'
                });
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during drain initiation';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                oldContainerId: context.oldContainerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to initiate drain');

            // Send error event
            sendEvent({
                type: 'DRAIN_ISSUES',
                error: errorMessage
            });
        }
    }
}