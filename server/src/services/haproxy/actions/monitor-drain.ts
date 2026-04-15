import type { ActionContext, DrainMonitorEmit } from './types';
import { getLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';

const logger = getLogger("deploy", "monitor-drain");

export class MonitorDrain {
    private haproxyClient: HAProxyDataPlaneClient;

    constructor() {
        this.haproxyClient = new HAProxyDataPlaneClient();
    }

    async execute(context: ActionContext, sendEvent: (event: DrainMonitorEmit) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            oldContainerId: context?.oldContainerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Monitoring blue server drain status...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for drain monitoring');
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
            }, 'Initializing HAProxy DataPlane client for drain monitoring');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            // Calculate server and backend names
            const backendName = context.applicationName;
            const serverName = `${context.applicationName}-${context.oldContainerId.slice(0, 8)}`;

            // Poll the server status to check when sessions reach 0
            const timeoutMs = 120000; // 2 minutes
            const pollIntervalMs = 2000; // Poll every 2 seconds
            const startTime = Date.now();

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                timeoutMs,
                pollIntervalMs
            }, 'Starting drain monitoring - polling server sessions');

            // Polling loop
            while (Date.now() - startTime < timeoutMs) {
                const serverStats = await this.haproxyClient.getServerStats(backendName, serverName);

                if (!serverStats) {
                    logger.warn({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName
                    }, 'Server not found during drain monitoring - may have been removed');

                    // If server is gone, consider drain complete
                    sendEvent({
                        type: 'DRAIN_COMPLETE'
                    });
                    return;
                }

                const currentSessions = serverStats.current_sessions || 0;

                logger.debug({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: serverStats.status,
                    currentSessions,
                    totalSessions: serverStats.total_sessions,
                    elapsedMs: Date.now() - startTime
                }, 'Drain monitoring - checking server sessions');

                // Check if drain is complete (0 active sessions)
                if (currentSessions === 0) {
                    logger.info({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName,
                        status: serverStats.status,
                        totalSessions: serverStats.total_sessions,
                        drainDurationMs: Date.now() - startTime
                    }, 'Drain monitoring complete - all connections closed');

                    sendEvent({
                        type: 'DRAIN_COMPLETE'
                    });
                    return;
                }

                // Wait before polling again
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }

            // Timeout reached
            const finalStats = await this.haproxyClient.getServerStats(backendName, serverName);
            logger.error({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                currentSessions: finalStats?.current_sessions || 'unknown',
                timeoutMs
            }, 'Drain monitoring timeout - connections did not drain within time limit');

            sendEvent({
                type: 'DRAIN_TIMEOUT',
                error: `Drain timeout after ${timeoutMs / 1000} seconds`
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during drain monitoring';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                oldContainerId: context.oldContainerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to monitor drain');

            // Send error event
            sendEvent({
                type: 'DRAIN_ISSUES',
                error: errorMessage
            });
        }
    }
}
