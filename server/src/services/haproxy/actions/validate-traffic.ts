import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';

const logger = loadbalancerLogger();

interface TrafficValidationMetrics {
    errorRate: number;
    connectionErrors: number;
    responseErrors: number;
    totalSessions: number;
    currentSessions: number;
    serverStatus: string;
    checkStatus: string;
}

export class ValidateTraffic {
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
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Validating traffic patterns...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for traffic validation');
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
            }, 'Initializing HAProxy DataPlane client for traffic validation');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            // Calculate server and backend names (matching previous actions)
            const backendName = context.applicationName;
            const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;

            const validationDurationMs = 30000; // 30 seconds minimum as defined in state machine
            const pollIntervalMs = 5000; // Poll every 5 seconds
            const startTime = Date.now();

            let validationErrors = 0;
            let lastMetrics: TrafficValidationMetrics | null = null;
            let baselineMetrics: TrafficValidationMetrics | null = null;

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                validationDurationMs,
                pollIntervalMs
            }, 'Starting traffic validation monitoring');

            // Validation loop - run exactly 3 times with 5 second pauses
            const maxValidations = 3;
            let validationCount = 0;

            while (validationCount < maxValidations) {
                try {
                    validationCount++;

                    logger.info({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName,
                        validationAttempt: validationCount,
                        maxValidations
                    }, `Traffic validation attempt ${validationCount}/${maxValidations}`);

                    // Get current server and backend statistics
                    const [serverStats, backendStats] = await Promise.all([
                        this.haproxyClient.getServerStats(backendName, serverName),
                        this.haproxyClient.getBackendStats(backendName)
                    ]);

                    if (!serverStats) {
                        logger.warn({
                            deploymentId: context.deploymentId,
                            backendName,
                            serverName,
                            validationAttempt: validationCount
                        }, 'Server stats not available during traffic validation');
                        validationErrors++;
                    } else if (!backendStats) {
                        logger.warn({
                            deploymentId: context.deploymentId,
                            backendName,
                            validationAttempt: validationCount
                        }, 'Backend stats not available during traffic validation');
                        validationErrors++;
                    } else {

                        // Calculate current metrics
                        const currentMetrics: TrafficValidationMetrics = {
                            errorRate: this.calculateErrorRate(serverStats),
                            connectionErrors: serverStats.errors_con,
                            responseErrors: serverStats.errors_resp,
                            totalSessions: serverStats.total_sessions,
                            currentSessions: serverStats.current_sessions,
                            serverStatus: serverStats.status,
                            checkStatus: serverStats.check_status
                        };

                        // Set baseline on first measurement
                        if (!baselineMetrics) {
                            baselineMetrics = { ...currentMetrics };
                            logger.info({
                                deploymentId: context.deploymentId,
                                backendName,
                                serverName,
                                baselineMetrics,
                                validationAttempt: validationCount
                            }, 'Established baseline metrics for traffic validation');
                        }

                        // Log current status
                        logger.info({
                            deploymentId: context.deploymentId,
                            backendName,
                            serverName,
                            currentMetrics,
                            validationAttempt: validationCount,
                            validationErrors
                        }, 'Traffic validation metrics');

                        // Validate traffic stability
                        const issues = this.validateMetrics(currentMetrics, baselineMetrics, lastMetrics);

                        if (issues.length > 0) {
                            validationErrors += issues.length;
                            logger.warn({
                                deploymentId: context.deploymentId,
                                backendName,
                                serverName,
                                issues,
                                currentMetrics,
                                validationErrors,
                                validationAttempt: validationCount
                            }, 'Traffic validation issues detected');
                        } else {
                            logger.info({
                                deploymentId: context.deploymentId,
                                backendName,
                                serverName,
                                currentMetrics,
                                validationAttempt: validationCount
                            }, 'Traffic validation metrics look healthy');
                        }

                        lastMetrics = currentMetrics;
                    }

                } catch (statsError) {
                    validationErrors++;
                    logger.warn({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName,
                        error: statsError instanceof Error ? statsError.message : 'Unknown error',
                        validationAttempt: validationCount,
                        validationErrors
                    }, 'Error getting stats during traffic validation');
                }

                // Wait 5 seconds before next validation (unless this is the last one)
                if (validationCount < maxValidations) {
                    logger.info({
                        deploymentId: context.deploymentId,
                        validationAttempt: validationCount,
                        nextValidationIn: '5 seconds'
                    }, 'Waiting before next validation');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            const totalTime = Date.now() - startTime;

            // Update context with validation errors count
            if (context.validationErrors !== undefined) {
                context.validationErrors = validationErrors;
            }

            // Determine if traffic is stable
            if (validationErrors === 0) {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    totalTime,
                    validationAttempts: validationCount,
                    validationErrors,
                    applicationName: context.applicationName
                }, 'Traffic validation completed successfully - traffic is stable');

                // Send success event
                sendEvent({
                    type: 'TRAFFIC_STABLE'
                });
            } else {
                logger.error({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    totalTime,
                    validationAttempts: validationCount,
                    validationErrors
                }, 'Traffic validation failed - critical issues detected');

                // Send critical issues event
                sendEvent({
                    type: 'CRITICAL_ISSUES',
                    error: `Traffic validation failed with ${validationErrors} validation errors after ${validationCount} attempts`
                });
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during traffic validation';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                containerId: context.containerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to validate traffic');

            // Update context with error state
            if (context.validationErrors !== undefined) {
                context.validationErrors = 999; // High error count to indicate failure
            }

            // Send critical issues event
            sendEvent({
                type: 'CRITICAL_ISSUES',
                error: errorMessage
            });
        }
    }

    /**
     * Calculate error rate based on server statistics
     */
    private calculateErrorRate(serverStats: any): number {
        const totalConnections = serverStats.total_sessions || 0;
        const connectionErrors = serverStats.errors_con || 0;
        const responseErrors = serverStats.errors_resp || 0;
        const totalErrors = connectionErrors + responseErrors;

        if (totalConnections === 0) {
            return 0; // No traffic yet
        }

        return (totalErrors / totalConnections) * 100;
    }

    /**
     * Validate current metrics against baseline and previous metrics
     */
    private validateMetrics(
        current: TrafficValidationMetrics,
        baseline: TrafficValidationMetrics,
        previous: TrafficValidationMetrics | null
    ): string[] {
        const issues: string[] = [];

        // Check if server is still healthy
        if (current.serverStatus !== 'UP') {
            issues.push(`Server status changed to ${current.serverStatus}`);
        }

        // Check for increased error rates
        const errorRateThreshold = 5.0; // 5% error rate threshold
        if (current.errorRate > errorRateThreshold) {
            issues.push(`High error rate: ${current.errorRate.toFixed(2)}% (threshold: ${errorRateThreshold}%)`);
        }

        // Check for significant increase in connection errors
        if (previous) {
            const connectionErrorIncrease = current.connectionErrors - previous.connectionErrors;
            if (connectionErrorIncrease > 10) {
                issues.push(`Connection errors increased by ${connectionErrorIncrease}`);
            }

            const responseErrorIncrease = current.responseErrors - previous.responseErrors;
            if (responseErrorIncrease > 10) {
                issues.push(`Response errors increased by ${responseErrorIncrease}`);
            }
        }

        // Check for error rate degradation compared to baseline
        if (current.errorRate > baseline.errorRate + 2.0) {
            issues.push(`Error rate increased by ${(current.errorRate - baseline.errorRate).toFixed(2)}% from baseline`);
        }

        return issues;
    }
}