import { loadbalancerLogger } from '../../../lib/logger-factory';
import prisma from '../../../lib/prisma';
import DockerService from '../../docker';
import { ContainerLifecycleManager } from '../../container';

const logger = loadbalancerLogger();

export class StopApplication {
    private dockerService: DockerService;
    private containerManager: ContainerLifecycleManager;

    constructor() {
        this.dockerService = DockerService.getInstance();
        this.containerManager = new ContainerLifecycleManager();
    }

    async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
        }, 'Action: Stopping application containers...');

        try {
            // Validate required context
            if (!context.applicationName) {
                throw new Error('Application name is required to identify containers to stop');
            }

            // Initialize Docker service if not already done
            await this.dockerService.initialize();

            let containersToStop: string[] = [];

            // If we have a specific container ID, stop only that container
            if (context.containerId) {
                containersToStop = [context.containerId];
                logger.info({
                    deploymentId: context.deploymentId,
                    containerId: context.containerId.slice(0, 12),
                    applicationName: context.applicationName
                }, 'Stopping specific container');
            } else {
                // Find all containers for the application
                const containers = await this.dockerService.listContainers(false);
                const applicationContainers = containers.filter((container: any) =>
                    container.labels?.[`mini-infra.application`] === context.applicationName ||
                    container.labels?.[`mini-infra.application-name`] === context.applicationName ||
                    container.labels?.[`application.name`] === context.applicationName ||
                    (container.names && container.names.some((name: string) => name.includes(context.applicationName)))
                );

                containersToStop = applicationContainers.map((container: any) => container.id);

                logger.info({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    containerCount: containersToStop.length,
                    containerIds: containersToStop.map(id => id.slice(0, 12))
                }, 'Found application containers to stop');
            }

            if (containersToStop.length === 0) {
                logger.info({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName
                }, 'No containers found to stop');

                sendEvent({
                    type: 'STOP_SUCCESS'
                });
                return;
            }

            // Stop each container gracefully
            const stopPromises = containersToStop.map(async (containerId) => {
                try {
                    logger.info({
                        deploymentId: context.deploymentId,
                        containerId: containerId.slice(0, 12),
                        applicationName: context.applicationName
                    }, 'Stopping container gracefully');

                    await this.containerManager.stopContainer(containerId, 30); // 30 second grace period

                    logger.info({
                        deploymentId: context.deploymentId,
                        containerId: containerId.slice(0, 12),
                        applicationName: context.applicationName
                    }, 'Container stopped successfully');

                    return { containerId, success: true };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    logger.error({
                        deploymentId: context.deploymentId,
                        containerId: containerId.slice(0, 12),
                        applicationName: context.applicationName,
                        error: errorMessage
                    }, 'Failed to stop container');

                    return { containerId, success: false, error: errorMessage };
                }
            });

            const results = await Promise.allSettled(stopPromises);
            const stopResults = results.map(result =>
                result.status === 'fulfilled' ? result.value : { success: false, error: 'Promise rejected' }
            );

            const successfulStops = stopResults.filter(result => result.success);
            const failedStops = stopResults.filter(result => !result.success);

            if (failedStops.length > 0) {
                logger.warn({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    totalContainers: containersToStop.length,
                    successful: successfulStops.length,
                    failed: failedStops.length,
                    failedContainers: failedStops.map(f => ({
                        containerId: 'containerId' in f ? f.containerId?.slice(0, 12) : 'unknown',
                        error: f.error
                    }))
                }, 'Some containers failed to stop');

                // If more than half failed, consider this a failure
                if (failedStops.length > successfulStops.length) {
                    throw new Error(`Failed to stop ${failedStops.length} out of ${containersToStop.length} containers`);
                }
            }

            // Wait a moment for containers to fully stop
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Mark containers as stopped in the deployment_containers table
            const successfulContainerIds = successfulStops
                .filter((r): r is { containerId: string; success: true } => 'containerId' in r)
                .map(r => r.containerId);
            if (successfulContainerIds.length > 0) {
                await this.markContainersStopped(context.deploymentId, successfulContainerIds);
            }

            logger.info({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                stoppedContainers: successfulStops.length,
                totalContainers: containersToStop.length
            }, 'Application containers stopped successfully');

            // Update context with containers that were stopped
            if (context.containersToRemove) {
                context.containersToRemove = [...context.containersToRemove, ...containersToStop];
            } else {
                context.containersToRemove = containersToStop;
            }

            // Send success event
            sendEvent({
                type: 'STOP_SUCCESS',
                stoppedContainers: containersToStop
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during container stop';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to stop application containers');

            // Send error event
            sendEvent({
                type: 'STOP_FAILED',
                error: errorMessage
            });
        }
    }

    /**
     * Mark containers as stopped in the deployment_containers table
     */
    private async markContainersStopped(deploymentId: string | undefined, containerIds: string[]): Promise<void> {
        try {
            if (!deploymentId || containerIds.length === 0) return;

            await prisma.deploymentContainer.updateMany({
                where: {
                    containerId: { in: containerIds },
                },
                data: {
                    status: 'stopped',
                },
            });

            logger.info({
                deploymentId,
                containerIds: containerIds.map(id => id.slice(0, 12)),
            }, 'Deployment containers marked as stopped in database');
        } catch (dbError) {
            logger.warn({
                deploymentId,
                containerIds: containerIds.map(id => id.slice(0, 12)),
                error: dbError instanceof Error ? dbError.message : 'Unknown error',
            }, 'Failed to mark deployment containers as stopped in database (non-critical)');
        }
    }
}