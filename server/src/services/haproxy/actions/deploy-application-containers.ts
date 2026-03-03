import { loadbalancerLogger } from '../../../lib/logger-factory';
import { ContainerLifecycleManager, ContainerCreateOptions } from '../../container';
import { DeploymentConfig, ContainerConfig } from '@mini-infra/types';
import { UserEventService } from '../../user-events';
import prisma from '../../../lib/prisma';

const logger = loadbalancerLogger();

export class DeployApplicationContainers {
    private containerManager: ContainerLifecycleManager;
    private userEventService: UserEventService;

    constructor() {
        this.containerManager = new ContainerLifecycleManager();
        this.userEventService = new UserEventService(prisma);
    }

    async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            dockerImage: context?.dockerImage,
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Deploying application containers...');

        try {
            // Validate required context
            if (!context.applicationName || !context.dockerImage || !context.haproxyNetworkName) {
                throw new Error('Missing required deployment context: applicationName, dockerImage, or haproxyNetworkName');
            }

            // Generate unique container name for this deployment
            const containerName = `${context.applicationName}-deployment-${context.deploymentId.slice(0, 8)}`;

            // Build container configuration from deployment config
            const containerConfig: ContainerConfig = context.config.containerConfig || {
                ports: [],
                volumes: [],
                environment: [],
                labels: {},
                networks: [context.haproxyNetworkName] // Ensure container joins HAProxy network
            };

            // Ensure the container is attached to the HAProxy network
            if (!containerConfig.networks.includes(context.haproxyNetworkName)) {
                containerConfig.networks.push(context.haproxyNetworkName);
            }

            // Add deployment-specific labels
            const deploymentLabels = {
                'mini-infra.deployment': context.deploymentId,
                'mini-infra.application': context.applicationName,
                'mini-infra.environment': context.environmentId,
                'mini-infra.type': 'initial-deployment',
                'mini-infra.created-at': new Date().toISOString(),
                ...containerConfig.labels
            };

            // Create container options
            const createOptions: ContainerCreateOptions = {
                name: containerName,
                image: context.dockerImage,
                config: {
                    ...containerConfig,
                    labels: deploymentLabels,
                    networks: containerConfig.networks
                },
                deploymentId: context.deploymentId,
                labels: deploymentLabels,
                environmentName: context.environmentName // Used to prefix volume names
            };

            logger.info({
                deploymentId: context.deploymentId,
                containerName,
                dockerImage: context.dockerImage,
                networks: containerConfig.networks,
                environmentId: context.environmentId
            }, 'Creating deployment container');

            // Log to user event that we're pulling the image
            if (context.userEventId) {
                const registryInfo = context.dockerImage.includes('ghcr.io') ? 'from GitHub Container Registry' :
                                   context.dockerImage.includes('docker.io') ? 'from Docker Hub' :
                                   context.dockerImage.split('/')[0].includes('.') ? `from ${context.dockerImage.split('/')[0]}` :
                                   'from Docker Hub';
                await this.userEventService.appendLogs(
                    context.userEventId,
                    `Pulling image '${context.dockerImage}' ${registryInfo}... (timeout: 10 minutes)`
                );
            }

            // Create the container
            const containerId = await this.containerManager.createContainer(createOptions);

            logger.info({
                deploymentId: context.deploymentId,
                containerId: containerId.slice(0, 12),
                containerName
            }, 'Container created, starting container');

            // Start the container
            await this.containerManager.startContainer(containerId);

            logger.info({
                deploymentId: context.deploymentId,
                containerId: containerId.slice(0, 12),
                containerName,
                applicationName: context.applicationName
            }, 'Application container deployed and started successfully');

            // Capture container for deployment tracking
            try {
                // Determine container role based on deployment type
                const containerRole = context.oldContainerId ? 'green' : 'new';

                await this.containerManager.captureContainerForDeployment({
                    deploymentId: context.deploymentId,
                    containerId: containerId,
                    containerRole: containerRole
                });

                logger.info({
                    deploymentId: context.deploymentId,
                    containerId: containerId.slice(0, 12),
                    containerName,
                    containerRole: containerRole
                }, 'Container captured for deployment tracking');
            } catch (captureError) {
                logger.warn({
                    deploymentId: context.deploymentId,
                    containerId: containerId.slice(0, 12),
                    error: captureError instanceof Error ? captureError.message : 'Unknown capture error'
                }, 'Failed to capture container for deployment tracking - continuing with deployment');
            }

            // Send success event with container ID and name
            sendEvent({
                type: 'DEPLOYMENT_SUCCESS',
                containerId: containerId,
                containerName: containerName
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during container deployment';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                dockerImage: context.dockerImage,
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to deploy application container');

            // Send error event
            sendEvent({
                type: 'DEPLOYMENT_ERROR',
                error: errorMessage
            });
        }
    }
}