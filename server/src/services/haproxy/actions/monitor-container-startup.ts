import { loadbalancerLogger } from '../../../lib/logger-factory';
import { ContainerLifecycleManager } from '../../container';
import DockerService from '../../docker';

const logger = loadbalancerLogger();

export class MonitorContainerStartup {
    private containerManager: ContainerLifecycleManager;
    private dockerService: DockerService;

    constructor() {
        this.containerManager = new ContainerLifecycleManager();
        this.dockerService = DockerService.getInstance();
    }

    async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            newContainerId: context?.newContainerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Monitoring container startup...');

        try {
            // Validate required context - check for newContainerId (green container) or containerId (fallback)
            const containerId = context.newContainerId || context.containerId;
            if (!containerId) {
                throw new Error('Container ID is required for startup monitoring (newContainerId or containerId)');
            }
            const timeoutMs = 120000; // 2 minutes as defined in state machine
            const pollIntervalMs = 2000; // Poll every 2 seconds

            logger.info({
                deploymentId: context.deploymentId,
                containerId: containerId.slice(0, 12),
                timeoutMs,
                pollIntervalMs
            }, 'Starting container startup monitoring');

            // Wait for container to reach running status
            const isRunning = await this.containerManager.waitForContainerStatus(
                containerId,
                'running',
                timeoutMs,
                pollIntervalMs
            );

            if (!isRunning) {
                // Get container status for error details
                const status = await this.containerManager.getContainerStatus(containerId);
                const errorDetails = status ? {
                    status: status.status,
                    exitCode: status.exitCode,
                    error: status.error
                } : 'Container status unavailable';

                logger.error({
                    deploymentId: context.deploymentId,
                    containerId: containerId.slice(0, 12),
                    containerStatus: errorDetails
                }, 'Container failed to start within timeout period');

                sendEvent({
                    type: 'STARTUP_TIMEOUT',
                    error: `Container failed to start within ${timeoutMs / 1000} seconds`
                });
                return;
            }

            // Container is running, now get its network information for HAProxy configuration
            logger.info({
                deploymentId: context.deploymentId,
                containerId: containerId.slice(0, 12)
            }, 'Container is running, retrieving network information');

            const networkInfo = await this.getContainerNetworkInfo(containerId, context.haproxyNetworkName);

            if (!networkInfo.ipAddress) {
                throw new Error(`Container is not connected to HAProxy network: ${context.haproxyNetworkName}`);
            }

            logger.info({
                deploymentId: context.deploymentId,
                containerId: containerId.slice(0, 12),
                ipAddress: networkInfo.ipAddress,
                containerName: networkInfo.containerName,
                networkName: context.haproxyNetworkName,
                listeningPort: networkInfo.listeningPort
            }, 'Container startup monitoring completed successfully');

            // Send success event with network information
            sendEvent({
                type: 'CONTAINERS_RUNNING',
                containerIpAddress: networkInfo.ipAddress,
                containerPort: networkInfo.listeningPort,
                containerName: networkInfo.containerName
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during container startup monitoring';

            logger.error({
                deploymentId: context.deploymentId,
                containerId: context.containerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to monitor container startup');

            // Send error event
            sendEvent({
                type: 'STARTUP_TIMEOUT',
                error: errorMessage
            });
        }
    }

    /**
     * Get container's network information for HAProxy configuration
     */
    private async getContainerNetworkInfo(containerId: string, networkName: string): Promise<{
        ipAddress: string | null;
        listeningPort: number | null;
        containerName: string | null;
    }> {
        try {
            await this.dockerService.initialize();
            const docker = await this.dockerService.getDockerInstance();
            const container = docker.getContainer(containerId);
            const containerInfo = await container.inspect();

            // Get IP address from the specified network
            const networks = containerInfo.NetworkSettings?.Networks || {};
            const networkInfo = networks[networkName];

            if (!networkInfo) {
                logger.warn({
                    containerId: containerId.slice(0, 12),
                    networkName,
                    availableNetworks: Object.keys(networks)
                }, 'Container not found on specified network');
                return { ipAddress: null, listeningPort: null, containerName: null };
            }

            // Extract container name (remove leading slash if present)
            const containerName = containerInfo.Name?.replace(/^\//, '') || null;

            const ipAddress = networkInfo.IPAddress;

            // Try to determine the listening port from exposed ports or configuration
            let listeningPort: number | null = null;
            const exposedPorts = containerInfo.Config?.ExposedPorts || {};
            const exposedPortKeys = Object.keys(exposedPorts);

            if (exposedPortKeys.length > 0) {
                // Get the first exposed port and extract the port number
                const firstExposedPort = exposedPortKeys[0];
                const portMatch = firstExposedPort.match(/^(\d+)/);
                if (portMatch) {
                    listeningPort = parseInt(portMatch[1], 10);
                }
            }

            // If no exposed port found, try to get from port bindings
            if (!listeningPort) {
                const portBindings = containerInfo.HostConfig?.PortBindings || {};
                const bindingKeys = Object.keys(portBindings);
                if (bindingKeys.length > 0) {
                    const firstBinding = bindingKeys[0];
                    const portMatch = firstBinding.match(/^(\d+)/);
                    if (portMatch) {
                        listeningPort = parseInt(portMatch[1], 10);
                    }
                }
            }

            logger.debug({
                containerId: containerId.slice(0, 12),
                networkName,
                ipAddress,
                listeningPort,
                containerName,
                exposedPorts: Object.keys(exposedPorts),
                portBindings: Object.keys(containerInfo.HostConfig?.PortBindings || {})
            }, 'Retrieved container network information');

            return {
                ipAddress,
                listeningPort,
                containerName
            };

        } catch (error) {
            logger.error({
                containerId: containerId.slice(0, 12),
                networkName,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Failed to get container network information');

            throw new Error(`Failed to get container network info: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
        }
    }
}