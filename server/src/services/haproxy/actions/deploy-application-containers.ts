import { loadbalancerLogger } from '../../../lib/logger-factory';
import { ContainerLifecycleManager, ContainerCreateOptions } from '../../container-lifecycle-manager';
import { DeploymentConfig, ContainerConfig } from '@mini-infra/types';

const logger = loadbalancerLogger();

export class DeployApplicationContainers {
    private containerManager: ContainerLifecycleManager;

    constructor() {
        this.containerManager = new ContainerLifecycleManager();
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

            // Send success event with container ID
            sendEvent({
                type: 'DEPLOYMENT_SUCCESS',
                containerId: containerId
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