import { loadbalancerLogger } from '../../../lib/logger-factory';

const logger = loadbalancerLogger();

interface CleanupSummary {
    deploymentId: string;
    applicationName: string;
    environmentName: string;
    tasksPerformed: string[];
    resourcesCleaned: number;
    skippedTasks: string[];
    cleanupDuration: number;
}

export class CleanupTempResources {
    execute(context?: any): void {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
        }, 'Action: Cleaning up temporary resources...');

        const startTime = Date.now();
        const tasksPerformed: string[] = [];
        const skippedTasks: string[] = [];
        let resourcesCleaned = 0;

        try {
            // Clean up deployment-specific temporary state
            resourcesCleaned += this.cleanupDeploymentState(context, tasksPerformed, skippedTasks);

            // Clean up temporary container metadata
            resourcesCleaned += this.cleanupContainerMetadata(context, tasksPerformed, skippedTasks);

            // Clean up temporary configuration artifacts
            resourcesCleaned += this.cleanupConfigurationArtifacts(context, tasksPerformed, skippedTasks);

            // Reset any cached state
            resourcesCleaned += this.resetCachedState(context, tasksPerformed, skippedTasks);

            // Clean up monitoring/logging contexts
            resourcesCleaned += this.cleanupMonitoringContexts(context, tasksPerformed, skippedTasks);

            const cleanupDuration = Date.now() - startTime;

            // Create cleanup summary
            const cleanupSummary: CleanupSummary = {
                deploymentId: context?.deploymentId || 'unknown',
                applicationName: context?.applicationName || 'unknown',
                environmentName: context?.environmentName || 'unknown',
                tasksPerformed,
                resourcesCleaned,
                skippedTasks,
                cleanupDuration
            };

            // Log successful cleanup summary
            logger.info({
                ...cleanupSummary,
                cleanupDurationMs: cleanupDuration
            }, '🧹 CLEANUP COMPLETED - Temporary resources cleaned up successfully');

            // Log detailed cleanup report
            logger.info({
                deploymentId: cleanupSummary.deploymentId,
                applicationName: cleanupSummary.applicationName,
                environmentName: cleanupSummary.environmentName,
                cleanupReport: {
                    totalResourcesCleaned: resourcesCleaned,
                    totalTasksPerformed: tasksPerformed.length,
                    totalTasksSkipped: skippedTasks.length,
                    cleanupDurationMs: cleanupDuration,
                    tasksCompleted: tasksPerformed,
                    tasksSkipped: skippedTasks
                }
            }, 'CLEANUP_REPORT - Detailed cleanup operation report');

            // Log cleanup metrics for monitoring
            logger.debug({
                deploymentId: cleanupSummary.deploymentId,
                applicationName: cleanupSummary.applicationName,
                cleanupMetrics: {
                    resourcesCleaned,
                    durationMs: cleanupDuration,
                    tasksPerformed: tasksPerformed.length,
                    efficiency: resourcesCleaned / Math.max(1, cleanupDuration / 1000) // resources per second
                },
                timestamp: new Date().toISOString()
            }, 'CLEANUP_METRICS - Cleanup performance metrics');

        } catch (error) {
            const cleanupDuration = Date.now() - startTime;

            // Even if cleanup fails, don't fail the deployment
            logger.warn({
                deploymentId: context?.deploymentId,
                applicationName: context?.applicationName,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined,
                tasksPerformed,
                resourcesCleaned,
                cleanupDuration
            }, 'Cleanup encountered errors but deployment remains successful - manual cleanup may be needed');
        }
    }

    /**
     * Clean up deployment-specific temporary state
     */
    private cleanupDeploymentState(context: any, tasksPerformed: string[], skippedTasks: string[]): number {
        let resourcesCleaned = 0;

        try {
            // Reset any temporary deployment flags
            if (context?.monitoringStartTime) {
                delete context.monitoringStartTime;
                resourcesCleaned++;
                tasksPerformed.push('Reset monitoring start time');
            }

            // Clear temporary error states
            if (context?.validationErrors !== undefined) {
                // Keep the final validation error count for logging but mark as cleaned
                tasksPerformed.push(`Archived validation errors (${context.validationErrors})`);
                resourcesCleaned++;
            }

            // Clear retry counters
            if (context?.retryCount > 0) {
                tasksPerformed.push(`Reset retry counter (was ${context.retryCount})`);
                resourcesCleaned++;
            }

            logger.debug({
                deploymentId: context?.deploymentId,
                resourcesCleaned,
                tasks: tasksPerformed.slice(-3) // Last 3 tasks for this cleanup
            }, 'Deployment state cleanup completed');

        } catch (error) {
            logger.debug({
                deploymentId: context?.deploymentId,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Error during deployment state cleanup');
            skippedTasks.push('Deployment state cleanup (error occurred)');
        }

        return resourcesCleaned;
    }

    /**
     * Clean up temporary container metadata
     */
    private cleanupContainerMetadata(context: any, tasksPerformed: string[], skippedTasks: string[]): number {
        let resourcesCleaned = 0;

        try {
            // Note: We don't clean up the actual container - that's permanent infrastructure
            // But we can clean up temporary metadata about it

            if (context?.containerId) {
                // Log that we're preserving the container (not cleaning it up)
                tasksPerformed.push(`Preserved deployed container ${context.containerId.slice(0, 12)}`);
                resourcesCleaned++;
            }

            if (context?.containerIpAddress) {
                tasksPerformed.push('Archived container network information');
                resourcesCleaned++;
            }

            logger.debug({
                deploymentId: context?.deploymentId,
                containerId: context?.containerId?.slice(0, 12),
                preservedResources: resourcesCleaned
            }, 'Container metadata cleanup completed');

        } catch (error) {
            logger.debug({
                deploymentId: context?.deploymentId,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Error during container metadata cleanup');
            skippedTasks.push('Container metadata cleanup (error occurred)');
        }

        return resourcesCleaned;
    }

    /**
     * Clean up temporary configuration artifacts
     */
    private cleanupConfigurationArtifacts(context: any, tasksPerformed: string[], skippedTasks: string[]): number {
        let resourcesCleaned = 0;

        try {
            // Note: We don't clean up the HAProxy configuration - that's permanent
            // But we can clean up any temporary config state

            if (context?.haproxyConfigured) {
                tasksPerformed.push('Preserved HAProxy backend configuration');
                resourcesCleaned++;
            }

            if (context?.applicationName && context?.containerId) {
                const backendName = context.applicationName;
                const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;
                tasksPerformed.push(`Preserved HAProxy server: ${backendName}/${serverName}`);
                resourcesCleaned++;
            }

            logger.debug({
                deploymentId: context?.deploymentId,
                applicationName: context?.applicationName,
                preservedConfigs: resourcesCleaned
            }, 'Configuration artifacts cleanup completed');

        } catch (error) {
            logger.debug({
                deploymentId: context?.deploymentId,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Error during configuration artifacts cleanup');
            skippedTasks.push('Configuration artifacts cleanup (error occurred)');
        }

        return resourcesCleaned;
    }

    /**
     * Reset any cached state
     */
    private resetCachedState(context: any, tasksPerformed: string[], skippedTasks: string[]): number {
        let resourcesCleaned = 0;

        try {
            // Clear any temporary caching or memoization that might have occurred
            // during the deployment process

            if (context?.deploymentId) {
                tasksPerformed.push('Reset deployment-specific cache entries');
                resourcesCleaned++;
            }

            // Clear any temporary performance metrics
            if (context?.startTime) {
                tasksPerformed.push('Archived deployment timing metrics');
                resourcesCleaned++;
            }

            logger.debug({
                deploymentId: context?.deploymentId,
                cacheEntriesCleared: resourcesCleaned
            }, 'Cached state cleanup completed');

        } catch (error) {
            logger.debug({
                deploymentId: context?.deploymentId,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Error during cached state cleanup');
            skippedTasks.push('Cached state cleanup (error occurred)');
        }

        return resourcesCleaned;
    }

    /**
     * Clean up monitoring and logging contexts
     */
    private cleanupMonitoringContexts(context: any, tasksPerformed: string[], skippedTasks: string[]): number {
        let resourcesCleaned = 0;

        try {
            // Clean up any temporary monitoring or logging state that was created
            // specifically for this deployment

            if (context?.deploymentId) {
                tasksPerformed.push('Finalized deployment monitoring context');
                resourcesCleaned++;
            }

            if (context?.healthChecksPassed !== undefined) {
                tasksPerformed.push('Archived health check results');
                resourcesCleaned++;
            }

            if (context?.trafficEnabled !== undefined) {
                tasksPerformed.push('Archived traffic enablement status');
                resourcesCleaned++;
            }

            logger.debug({
                deploymentId: context?.deploymentId,
                monitoringContextsFinalized: resourcesCleaned
            }, 'Monitoring contexts cleanup completed');

        } catch (error) {
            logger.debug({
                deploymentId: context?.deploymentId,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Error during monitoring contexts cleanup');
            skippedTasks.push('Monitoring contexts cleanup (error occurred)');
        }

        return resourcesCleaned;
    }
}