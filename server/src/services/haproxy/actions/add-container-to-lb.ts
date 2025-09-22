import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient, BackendConfig, ServerConfig } from '../haproxy-dataplane-client';
import { HealthCheckConfig } from '@mini-infra/types';

const logger = loadbalancerLogger();

export class AddContainerToLB {
    private haproxyClient: HAProxyDataPlaneClient;

    constructor() {
        this.haproxyClient = new HAProxyDataPlaneClient();
    }

    async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            containerIpAddress: context?.containerIpAddress,
            containerPort: context?.containerPort,
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Adding container backend and servers to HAProxy...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for load balancer configuration');
            }
            if (!context.applicationName) {
                throw new Error('Application name is required for backend configuration');
            }
            if (!context.containerIpAddress) {
                throw new Error('Container IP address is required for server configuration');
            }
            if (!context.containerPort) {
                throw new Error('Container port is required for server configuration');
            }
            if (!context.config?.healthCheck) {
                throw new Error('Health check configuration is required for server setup');
            }

            // Initialize HAProxy DataPlane client
            logger.info({
                deploymentId: context.deploymentId,
                haproxyContainerId: context.haproxyContainerId.slice(0, 12),
                applicationName: context.applicationName
            }, 'Initializing HAProxy DataPlane client');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            // Create backend configuration
            const backendName = context.applicationName;
            const backendConfig: BackendConfig = {
                name: backendName,
                mode: 'http',
                balance: 'roundrobin',
                check_timeout: 5000,
                connect_timeout: 5000,
                server_timeout: 10000
            };

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                backendConfig
            }, 'Creating HAProxy backend');

            // Check if backend already exists
            const existingBackend = await this.haproxyClient.getBackend(backendName);
            if (!existingBackend) {
                // Create the backend
                await this.haproxyClient.createBackend(backendConfig);
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName
                }, 'HAProxy backend created successfully');
            } else {
                logger.info({
                    deploymentId: context.deploymentId,
                    backendName
                }, 'HAProxy backend already exists, skipping creation');
            }

            // Extract health check configuration from deployment config
            const healthCheck: HealthCheckConfig = context.config.healthCheck;
            const healthCheckEndpoint = healthCheck.endpoint || '/health';

            // Configure server with health check settings
            const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;
            const serverConfig: ServerConfig = {
                name: serverName,
                address: context.containerIpAddress,
                port: context.containerPort,
                check: 'enabled',
                check_path: healthCheckEndpoint,
                inter: healthCheck.interval || 2000, // Default 2 seconds
                rise: Math.max(2, healthCheck.retries || 2), // At least 2 successful checks to mark UP
                fall: 3, // 3 failed checks to mark DOWN
                weight: 100,
                enabled: true,
                maintenance: 'disabled'
            };

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                serverConfig: {
                    address: serverConfig.address,
                    port: serverConfig.port,
                    check_path: serverConfig.check_path,
                    inter: serverConfig.inter,
                    rise: serverConfig.rise,
                    fall: serverConfig.fall
                }
            }, 'Adding server to HAProxy backend with health check configuration');

            // Add server to backend
            await this.haproxyClient.addServer(backendName, serverConfig);

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                address: context.containerIpAddress,
                port: context.containerPort,
                healthCheckEndpoint,
                applicationName: context.applicationName
            }, 'Container successfully added to HAProxy load balancer');

            // Send success event
            sendEvent({
                type: 'LB_CONFIGURED'
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during HAProxy configuration';

            logger.error({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                containerId: context.containerId?.slice(0, 12),
                containerIpAddress: context.containerIpAddress,
                containerPort: context.containerPort,
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to configure HAProxy load balancer');

            // Send error event
            sendEvent({
                type: 'LB_CONFIG_ERROR',
                error: errorMessage
            });
        }
    }
}