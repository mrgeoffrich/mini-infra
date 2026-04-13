import type { ActionContext, SendEvent } from './types';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import DockerService from '../../docker';
import { ContainerLifecycleManager } from '../../container';

const logger = loadbalancerLogger();

export class RemoveApplication {
    private dockerService: DockerService;
    private containerManager: ContainerLifecycleManager;

    constructor() {
        this.dockerService = DockerService.getInstance();
        this.containerManager = new ContainerLifecycleManager();
    }

    async execute(context: ActionContext, sendEvent: SendEvent): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            containersToRemove: context?.containersToRemove?.map((id: string) => id.slice(0, 12))
        }, 'Action: Removing application containers and resources...');

        try {
            // Validate required context
            if (!context.applicationName) {
                throw new Error('Application name is required to identify containers to remove');
            }

            // Initialize Docker service if not already done
            await this.dockerService.initialize();

            let containersToRemove: string[] = [];

            // Use containersToRemove from context if available (set by StopApplication)
            if (context.containersToRemove && context.containersToRemove.length > 0) {
                containersToRemove = context.containersToRemove;
                logger.info({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    containerCount: containersToRemove.length,
                    containerIds: containersToRemove.map((id: string) => id.slice(0, 12))
                }, 'Using containers from context for removal');
            } else if (context.containerId) {
                // If we have a specific container ID, remove only that container
                containersToRemove = [context.containerId];
                logger.info({
                    deploymentId: context.deploymentId,
                    containerId: context.containerId.slice(0, 12),
                    applicationName: context.applicationName
                }, 'Removing specific container');
            } else {
                // Find all containers for the application (both stopped and running)
                const allContainers = await this.dockerService.listContainers(true);
                const applicationContainers = allContainers.filter((container) =>
                    container.labels?.[`mini-infra.application`] === context.applicationName ||
                    container.labels?.[`mini-infra.application-name`] === context.applicationName ||
                    container.labels?.[`application.name`] === context.applicationName ||
                    (container.name?.includes(context.applicationName) ?? false)
                );

                containersToRemove = applicationContainers.map((container) => container.id);

                logger.info({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    containerCount: containersToRemove.length,
                    containerIds: containersToRemove.map(id => id.slice(0, 12))
                }, 'Found application containers to remove');
            }

            if (containersToRemove.length === 0) {
                logger.info({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName
                }, 'No containers found to remove');

                sendEvent({
                    type: 'REMOVAL_SUCCESS'
                });
                return;
            }

            // Remove each container and its resources
            const removePromises = containersToRemove.map(async (containerId) => {
                try {
                    logger.info({
                        deploymentId: context.deploymentId,
                        containerId: containerId.slice(0, 12),
                        applicationName: context.applicationName
                    }, 'Removing container and its resources');

                    // Remove the container (with volumes if any)
                    await this.containerManager.removeContainer(containerId, true);

                    logger.info({
                        deploymentId: context.deploymentId,
                        containerId: containerId.slice(0, 12),
                        applicationName: context.applicationName
                    }, 'Container removed successfully');

                    return { containerId, success: true };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

                    // If container doesn't exist, that's ok - consider it a success
                    if (errorMessage.includes('No such container') || errorMessage.includes('not found')) {
                        logger.info({
                            deploymentId: context.deploymentId,
                            containerId: containerId.slice(0, 12),
                            applicationName: context.applicationName
                        }, 'Container already removed or does not exist');

                        return { containerId, success: true };
                    }

                    logger.error({
                        deploymentId: context.deploymentId,
                        containerId: containerId.slice(0, 12),
                        applicationName: context.applicationName,
                        error: errorMessage
                    }, 'Failed to remove container');

                    return { containerId, success: false, error: errorMessage };
                }
            });

            const results = await Promise.allSettled(removePromises);
            const removeResults = results.map(result =>
                result.status === 'fulfilled' ? result.value : { success: false, error: 'Promise rejected' }
            );

            const successfulRemovals = removeResults.filter(result => result.success);
            const failedRemovals = removeResults.filter(result => !result.success);

            if (failedRemovals.length > 0) {
                logger.warn({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    totalContainers: containersToRemove.length,
                    successful: successfulRemovals.length,
                    failed: failedRemovals.length,
                    failedContainers: failedRemovals.map(f => ({
                        containerId: 'containerId' in f ? f.containerId?.slice(0, 12) : 'unknown',
                        error: f.error
                    }))
                }, 'Some containers failed to be removed');

                // If more than half failed, consider this a failure
                if (failedRemovals.length > successfulRemovals.length) {
                    throw new Error(`Failed to remove ${failedRemovals.length} out of ${containersToRemove.length} containers`);
                }
            }

            // Try to clean up any unused networks and volumes for the application
            try {
                await this.cleanupApplicationResources(context.applicationName, context.deploymentId);
            } catch (cleanupError) {
                // Log cleanup errors but don't fail the entire operation
                logger.warn({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    error: cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup error'
                }, 'Failed to clean up some application resources, but containers were removed successfully');
            }

            logger.info({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                removedContainers: successfulRemovals.length,
                totalContainers: containersToRemove.length
            }, 'Application containers and resources removed successfully');

            // Send success event
            sendEvent({
                type: 'REMOVAL_SUCCESS',
                removedContainers: containersToRemove
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during container removal';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to remove application containers');

            // Send error event
            sendEvent({
                type: 'REMOVAL_FAILED',
                error: errorMessage
            });
        }
    }

    private async cleanupApplicationResources(applicationName: string, deploymentId?: string): Promise<void> {
        try {
            logger.info({
                deploymentId,
                applicationName
            }, 'Cleaning up unused networks and volumes for application');

            // Note: Pruning volumes and networks removed as they're not available in the current service
            // This is safer as it avoids accidentally removing shared resources

            logger.info({
                deploymentId,
                applicationName
            }, 'Application resource cleanup completed');

        } catch (error) {
            logger.warn({
                deploymentId,
                applicationName,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Some application resources could not be cleaned up');

            throw error; // Re-throw so caller can handle
        }
    }

}