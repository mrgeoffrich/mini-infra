import type { ActionContext, LBRemovalEmit } from './types';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';
import DockerService from '../../docker';
import prisma from '../../../lib/prisma';

const logger = loadbalancerLogger();

export class RemoveContainerFromLB {
    private haproxyClient: HAProxyDataPlaneClient;
    private dockerService: DockerService;

    constructor() {
        this.haproxyClient = new HAProxyDataPlaneClient();
        this.dockerService = DockerService.getInstance();
    }

    /**
     * Check if a container exists in Docker by extracting the container ID from the server name
     * Server names follow the pattern: {applicationName}-{containerId-first-8-chars}
     */
    private async containerExists(serverName: string, applicationName: string): Promise<boolean> {
        try {
            // Extract container ID prefix from server name (e.g., "geoffsnginx-ac4d64b7" -> "ac4d64b7")
            const containerIdPrefix = serverName.replace(`${applicationName}-`, '');

            // Initialize Docker service
            await this.dockerService.initialize();
            const docker = await this.dockerService.getDockerInstance();

            // List all containers (including stopped ones) that match the prefix
            const containers = await docker.listContainers({ all: true });
            const matchingContainer = containers.find(c => c.Id.startsWith(containerIdPrefix));

            return !!matchingContainer;
        } catch (error) {
            logger.warn({
                serverName,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 'Failed to check if container exists, assuming it does not exist');
            return false;
        }
    }

    async execute(context: ActionContext, sendEvent: (event: LBRemovalEmit) => void): Promise<void> {
        logger.info({
            operationId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyNetworkName: context?.haproxyNetworkName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Removing container backend and servers from HAProxy...');

        try {
            // Validate required context
            if (!context.haproxyContainerId) {
                throw new Error('HAProxy container ID is required for load balancer configuration');
            }
            if (!context.applicationName) {
                throw new Error('Application name is required for backend configuration');
            }

            // Initialize HAProxy DataPlane client
            logger.info({
                operationId: context.deploymentId,
                haproxyContainerId: context.haproxyContainerId.slice(0, 12),
                applicationName: context.applicationName
            }, 'Initializing HAProxy DataPlane client for removal');

            await this.haproxyClient.initialize(context.haproxyContainerId);

            const backendName = context.applicationName;

            // Check if backend exists
            const existingBackend = await this.haproxyClient.getBackend(backendName);
            if (!existingBackend) {
                logger.info({
                    operationId: context.deploymentId,
                    backendName
                }, 'HAProxy backend does not exist, skipping removal');

                sendEvent({
                    type: 'LB_REMOVAL_SUCCESS'
                });
                return;
            }

            // If we have a specific container ID, remove only that server
            if (context.containerId) {
                const serverName = `${context.applicationName}-${context.containerId.slice(0, 8)}`;

                logger.info({
                    operationId: context.deploymentId,
                    backendName,
                    serverName
                }, 'Removing specific server from HAProxy backend');

                // Check if server exists in runtime before attempting deletion
                const serverInRuntime = await this.haproxyClient.isServerInRuntime(backendName, serverName);
                if (serverInRuntime) {
                    await this.haproxyClient.deleteServer(backendName, serverName);
                    logger.info({
                        operationId: context.deploymentId,
                        backendName,
                        serverName
                    }, 'Server successfully removed from HAProxy backend');
                } else {
                    logger.info({
                        operationId: context.deploymentId,
                        backendName,
                        serverName
                    }, 'Server not found in HAProxy runtime, skipping server removal');
                }

                // Delete server from database
                await this.deleteServerRecord(backendName, serverName, context.environmentId);
            }

            // Clean up any stale servers (servers whose containers no longer exist)
            logger.info({
                operationId: context.deploymentId,
                backendName
            }, 'Checking for stale servers in HAProxy backend');

            const servers = await this.haproxyClient.listServers(backendName);
            if (servers && servers.length > 0) {
                const staleServers: string[] = [];

                for (const server of servers) {
                    const exists = await this.containerExists(server.name, context.applicationName);
                    if (!exists) {
                        staleServers.push(server.name);
                    }
                }

                if (staleServers.length > 0) {
                    logger.info({
                        operationId: context.deploymentId,
                        backendName,
                        staleServers,
                        count: staleServers.length
                    }, 'Found stale servers to remove from HAProxy backend');

                    for (const serverName of staleServers) {
                        try {
                            const serverInRuntime = await this.haproxyClient.isServerInRuntime(backendName, serverName);
                            if (serverInRuntime) {
                                await this.haproxyClient.deleteServer(backendName, serverName);
                                logger.info({
                                    operationId: context.deploymentId,
                                    backendName,
                                    serverName
                                }, 'Stale server successfully removed from HAProxy backend');
                            }
                            // Delete stale server from database
                            await this.deleteServerRecord(backendName, serverName, context.environmentId);
                        } catch (error) {
                            logger.warn({
                                operationId: context.deploymentId,
                                backendName,
                                serverName,
                                error: error instanceof Error ? error.message : 'Unknown error'
                            }, 'Failed to remove stale server, continuing with cleanup');
                        }
                    }
                } else {
                    logger.info({
                        operationId: context.deploymentId,
                        backendName,
                        totalServers: servers.length
                    }, 'No stale servers found in HAProxy backend');
                }
            }

            // Check if backend has any remaining servers
            const remainingServers = await this.haproxyClient.listServers(backendName);
            if (!remainingServers || remainingServers.length === 0) {
                logger.info({
                    operationId: context.deploymentId,
                    backendName
                }, 'Backend has no remaining servers - backend will be removed after frontend cleanup');

                // Delete backend from database
                await this.deleteBackendRecord(backendName, context.environmentId);
            } else {
                logger.info({
                    operationId: context.deploymentId,
                    backendName,
                    remainingServers: remainingServers.length
                }, 'Backend still has servers, keeping backend configuration');
            }

            logger.info({
                operationId: context.deploymentId,
                applicationName: context.applicationName,
                backendName
            }, 'Container successfully removed from HAProxy load balancer');

            // Send success event
            sendEvent({
                type: 'LB_REMOVAL_SUCCESS'
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error during HAProxy removal';

            logger.error({
                operationId: context.deploymentId,
                applicationName: context.applicationName,
                containerId: context.containerId?.slice(0, 12),
                haproxyContainerId: context.haproxyContainerId?.slice(0, 12),
                error: errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Failed to remove container from HAProxy load balancer');

            // Send error event
            sendEvent({
                type: 'LB_REMOVAL_FAILED',
                error: errorMessage
            });
        }
    }

    /**
     * Delete a server record from the database
     */
    private async deleteServerRecord(backendName: string, serverName: string, environmentId?: string): Promise<void> {
        try {
            if (!environmentId) return;

            const backend = await prisma.hAProxyBackend.findUnique({
                where: {
                    name_environmentId: {
                        name: backendName,
                        environmentId,
                    },
                },
            });

            if (!backend) return;

            await prisma.hAProxyServer.deleteMany({
                where: {
                    name: serverName,
                    backendId: backend.id,
                },
            });

            logger.info({ backendName, serverName }, 'Server deleted from database');
        } catch (dbError) {
            logger.warn({
                backendName,
                serverName,
                error: dbError instanceof Error ? dbError.message : 'Unknown error',
            }, 'Failed to delete server from database (non-critical)');
        }
    }

    /**
     * Delete a backend record from the database
     */
    private async deleteBackendRecord(backendName: string, environmentId?: string): Promise<void> {
        try {
            if (!environmentId) return;

            await prisma.hAProxyBackend.deleteMany({
                where: {
                    name: backendName,
                    environmentId,
                },
            });

            logger.info({ backendName }, 'Backend deleted from database');
        } catch (dbError) {
            logger.warn({
                backendName,
                error: dbError instanceof Error ? dbError.message : 'Unknown error',
            }, 'Failed to delete backend from database (non-critical)');
        }
    }
}