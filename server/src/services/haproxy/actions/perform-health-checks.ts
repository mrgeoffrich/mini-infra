import type { ActionContext, HealthCheckEmit } from './types';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';

const logger = loadbalancerLogger();

export class PerformHealthChecks {
    private haproxyClient: HAProxyDataPlaneClient;

    constructor() {
        this.haproxyClient = new HAProxyDataPlaneClient();
    }

    async execute(context: ActionContext, sendEvent: (event: HealthCheckEmit) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Performing health checks on servers...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for health check monitoring');
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
            }, 'Initializing HAProxy DataPlane client for health check monitoring');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            // Calculate server and backend names (matching AddContainerToLB logic)
            const backendName = context.applicationName;
            const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;

            const timeoutMs = 90000; // 90 seconds as defined in state machine
            const pollIntervalMs = 2000; // Poll every 2 seconds
            const startTime = Date.now();

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                timeoutMs,
                pollIntervalMs
            }, 'Starting HAProxy health check monitoring');

            // Poll HAProxy server stats until server is healthy or timeout
            let isHealthy = false;
            let lastStatus = 'UNKNOWN';
            let lastCheckStatus = 'UNKNOWN';

            while (!isHealthy && (Date.now() - startTime) < timeoutMs) {
                try {
                    // Get server statistics from HAProxy
                    const serverStats = await this.haproxyClient.getServerStats(backendName, serverName);

                    if (!serverStats) {
                        logger.warn({
                            deploymentId: context.deploymentId,
                            backendName,
                            serverName
                        }, 'Server not found in HAProxy stats - may not be configured yet');
                    } else {
                        lastStatus = serverStats.status;
                        lastCheckStatus = serverStats.check_status;

                        logger.debug({
                            deploymentId: context.deploymentId,
                            backendName,
                            serverName,
                            status: serverStats.status,
                            checkStatus: serverStats.check_status,
                            checkDuration: serverStats.check_duration,
                            elapsedTime: Date.now() - startTime
                        }, 'HAProxy server health check status');

                        // Check if server is healthy (status is UP)
                        if (serverStats.status === 'UP') {
                            isHealthy = true;
                            logger.info({
                                deploymentId: context.deploymentId,
                                backendName,
                                serverName,
                                status: serverStats.status,
                                checkStatus: serverStats.check_status,
                                totalTime: Date.now() - startTime
                            }, 'Server is healthy in HAProxy');
                            break;
                        }

                        // Log intermediate status for debugging
                        if (serverStats.status === 'DOWN' && serverStats.check_status) {
                            logger.info({
                                deploymentId: context.deploymentId,
                                backendName,
                                serverName,
                                status: serverStats.status,
                                checkStatus: serverStats.check_status,
                                elapsedTime: Date.now() - startTime
                            }, 'Server health check in progress');
                        }
                    }
                } catch (statsError) {
                    logger.warn({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName,
                        error: statsError instanceof Error ? statsError.message : 'Unknown error',
                        elapsedTime: Date.now() - startTime
                    }, 'Error getting server stats during health check monitoring');
                }

                // Wait before next poll
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }

            if (isHealthy) {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    status: lastStatus,
                    checkStatus: lastCheckStatus,
                    totalTime: Date.now() - startTime,
                    applicationName: context.applicationName
                }, 'Health checks passed - server is healthy in HAProxy');

                // Send success event
                sendEvent({
                    type: 'SERVERS_HEALTHY'
                });
            } else {
                const totalTime = Date.now() - startTime;
                logger.error({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    lastStatus,
                    lastCheckStatus,
                    totalTime,
                    timeoutMs
                }, 'Health check timeout - server did not become healthy within time limit');

                // Send timeout event
                sendEvent({
                    type: 'HEALTH_CHECK_TIMEOUT',
                    error: `Server did not become healthy within ${timeoutMs / 1000} seconds. Last status: ${lastStatus}, Check status: ${lastCheckStatus}`
                });
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during health check monitoring';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                containerId: context.containerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to perform health checks');

            // Send error event
            sendEvent({
                type: 'HEALTH_CHECK_TIMEOUT',
                error: errorMessage
            });
        }
    }
}