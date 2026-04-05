import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient, BackendConfig, ServerConfig } from '../haproxy-dataplane-client';
import prisma from '../../../lib/prisma';

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
            containerName: context?.containerName,
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
            if (!context.containerName && !context.containerIpAddress) {
                throw new Error('Container name or IP address is required for server configuration');
            }
            if (!context.containerPort) {
                throw new Error('Container port is required for server configuration');
            }
            if (!context.healthCheckEndpoint) {
                logger.info({
                    deploymentId: context.deploymentId,
                }, 'No explicit health check config, using defaults');
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

            // Resolve health check configuration from context fields
            const healthCheckEndpoint = context.healthCheckEndpoint ?? '/health';
            const healthCheckInterval = context.healthCheckInterval ?? 2000;
            const healthCheckRetries = context.healthCheckRetries ?? 2;

            // Configure server with health check settings
            // Use container name for DNS resolution (preferred) or fall back to IP address
            const serverAddress = context.containerName || context.containerIpAddress;
            const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;
            const serverConfig: ServerConfig = {
                name: serverName,
                address: serverAddress,
                port: context.containerPort,
                check: 'enabled',
                check_path: healthCheckEndpoint,
                inter: healthCheckInterval,
                rise: Math.max(2, healthCheckRetries),
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
                    containerName: context.containerName,
                    containerIpAddress: context.containerIpAddress,
                    port: serverConfig.port,
                    check_path: serverConfig.check_path,
                    inter: serverConfig.inter,
                    rise: serverConfig.rise,
                    fall: serverConfig.fall
                }
            }, 'Adding server to HAProxy backend with health check configuration (using DNS name for Docker resolution)');

            // Add server to backend
            await this.haproxyClient.addServer(backendName, serverConfig);

            logger.info({
                deploymentId: context.deploymentId,
                backendName,
                serverName,
                address: serverAddress,
                containerName: context.containerName,
                containerIpAddress: context.containerIpAddress,
                port: context.containerPort,
                healthCheckEndpoint,
                applicationName: context.applicationName
            }, 'Container successfully added to HAProxy load balancer');

            // Persist backend and server records to database
            try {
                if (context.environmentId) {
                    const backendRecord = await prisma.hAProxyBackend.upsert({
                        where: {
                            name_environmentId: {
                                name: backendName,
                                environmentId: context.environmentId,
                            },
                        },
                        update: {
                            mode: backendConfig.mode || 'http',
                            balanceAlgorithm: backendConfig.balance || 'roundrobin',
                            checkTimeout: backendConfig.check_timeout ?? null,
                            connectTimeout: backendConfig.connect_timeout ?? null,
                            serverTimeout: backendConfig.server_timeout ?? null,
                            status: 'active',
                            errorMessage: null,
                        },
                        create: {
                            name: backendName,
                            environmentId: context.environmentId,
                            mode: backendConfig.mode || 'http',
                            balanceAlgorithm: backendConfig.balance || 'roundrobin',
                            checkTimeout: backendConfig.check_timeout ?? null,
                            connectTimeout: backendConfig.connect_timeout ?? null,
                            serverTimeout: backendConfig.server_timeout ?? null,
                            sourceType: context.sourceType ?? 'stack',
                            status: 'active',
                        },
                    });

                    await prisma.hAProxyServer.upsert({
                        where: {
                            name_backendId: {
                                name: serverName,
                                backendId: backendRecord.id,
                            },
                        },
                        update: {
                            address: serverAddress,
                            port: context.containerPort,
                            check: serverConfig.check || 'enabled',
                            checkPath: serverConfig.check_path || null,
                            inter: serverConfig.inter ?? null,
                            rise: serverConfig.rise ?? null,
                            fall: serverConfig.fall ?? null,
                            weight: serverConfig.weight ?? 100,
                            enabled: serverConfig.enabled ?? true,
                            maintenance: serverConfig.maintenance === 'enabled',
                            containerId: context.containerId ?? null,
                            containerName: context.containerName ?? null,
                            status: 'active',
                            errorMessage: null,
                        },
                        create: {
                            name: serverName,
                            backendId: backendRecord.id,
                            address: serverAddress,
                            port: context.containerPort,
                            check: serverConfig.check || 'enabled',
                            checkPath: serverConfig.check_path || null,
                            inter: serverConfig.inter ?? null,
                            rise: serverConfig.rise ?? null,
                            fall: serverConfig.fall ?? null,
                            weight: serverConfig.weight ?? 100,
                            enabled: serverConfig.enabled ?? true,
                            maintenance: serverConfig.maintenance === 'enabled',
                            containerId: context.containerId ?? null,
                            containerName: context.containerName ?? null,
                            status: 'active',
                        },
                    });

                    logger.info({
                        deploymentId: context.deploymentId,
                        backendName,
                        serverName,
                        backendRecordId: backendRecord.id,
                    }, 'Backend and server records persisted to database');
                }
            } catch (dbError) {
                // DB write failure is non-critical - remediation can reconcile later
                logger.warn({
                    deploymentId: context.deploymentId,
                    backendName,
                    serverName,
                    error: dbError instanceof Error ? dbError.message : 'Unknown error',
                }, 'Failed to persist backend/server records to database (non-critical)');
            }

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
                containerName: context.containerName,
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