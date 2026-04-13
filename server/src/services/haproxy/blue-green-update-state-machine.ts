import { assign, setup } from 'xstate';
import { deploymentLogger } from '../../lib/logger-factory';
import type { DeploymentVolume } from '@mini-infra/types';
import { DeployApplicationContainers } from './actions/deploy-application-containers';
import { MonitorContainerStartup } from './actions/monitor-container-startup';
import { AddContainerToLB } from './actions/add-container-to-lb';
import { PerformHealthChecks } from './actions/perform-health-checks';
import { InitiateDrain } from './actions/initiate-drain';
import { MonitorDrain } from './actions/monitor-drain';
import { RemoveContainerFromLB } from './actions/remove-container-from-lb';
import { StopApplication } from './actions/stop-application';
import { RemoveApplication } from './actions/remove-application';
import { LogDeploymentSuccess } from './actions/log-deployment-success';
import { AlertOperationsTeam } from './actions/alert-operations-team';
import { CleanupTempResources, type CleanupContext } from './actions/cleanup-temp-resources';
import { EnableTraffic } from './actions/enable-traffic';

// Create instances of action classes
const deployApplicationContainers = new DeployApplicationContainers();
const monitorContainerStartup = new MonitorContainerStartup();
const addContainerToLB = new AddContainerToLB();
const performHealthChecks = new PerformHealthChecks();
const initiateDrain = new InitiateDrain();
const monitorDrain = new MonitorDrain();
const removeContainerFromLB = new RemoveContainerFromLB();
const stopApplication = new StopApplication();
const removeApplication = new RemoveApplication();
const logDeploymentSuccess = new LogDeploymentSuccess();
const alertOperationsTeam = new AlertOperationsTeam();
const cleanupTempResources = new CleanupTempResources();
const enableTraffic = new EnableTraffic();

// Types for context and events
// Note in a blue green update Blue is the old container set, Green is the new container set
export interface BlueGreenUpdateContext {
    // Deployment identifiers
    deploymentId: string;
    configurationId: string;
    applicationName: string;
    dockerImage: string;

    // User event tracking
    userEventId?: string;

    // Environment context
    environmentId: string;
    environmentName: string;
    haproxyContainerId: string;
    haproxyNetworkName: string;

    // Container state
    blueHealthy: boolean;
    greenHealthy: boolean;
    greenBackendConfigured: boolean;
    trafficOpenedToGreen: boolean;
    trafficValidated: boolean;
    blueDraining: boolean;
    blueDrained: boolean;
    validationErrors: number;
    drainStartTime?: number;
    monitoringStartTime?: number;
    error?: string;
    retryCount: number;
    activeConnections: number;
    oldContainerId?: string;
    newContainerId?: string;
    containerName?: string;
    containerIpAddress?: string;
    containerPort?: number;

    // Deployment metadata
    triggerType: string;
    triggeredBy?: string;
    startTime: number;

    // Configuration
    config?: Record<string, unknown>;

    // Source-agnostic configuration (used by actions instead of DB lookups)
    // When set, actions read from these fields directly.
    // When unset, actions fall back to context.config / DB lookups for backwards compatibility.
    hostname?: string;
    enableSsl?: boolean;
    tlsCertificateId?: string;
    certificateStatus?: string;
    networkType?: string;
    healthCheckEndpoint?: string;
    healthCheckInterval?: number;
    healthCheckRetries?: number;
    containerPorts?: { containerPort: number; hostPort: number; protocol: 'tcp' | 'udp' }[];
    containerVolumes?: DeploymentVolume[];
    containerEnvironment?: Record<string, string>;
    containerLabels?: Record<string, string>;
    containerNetworks?: string[];
}

type BlueGreenUpdateEvent =
    // Deployment initiation
    | { type: 'START_DEPLOYMENT' }

    // Green deployment events
    | { type: 'DEPLOYMENT_SUCCESS'; containerId: string; containerName?: string }
    | { type: 'DEPLOYMENT_ERROR'; error: string }
    | { type: 'CONTAINERS_RUNNING'; containerIpAddress: string; containerPort?: number; containerName?: string }
    | { type: 'STARTUP_TIMEOUT' }

    // Load balancer configuration events
    | { type: 'LB_CONFIGURED' }
    | { type: 'LB_CONFIG_ERROR'; error: string }

    // Health check events
    | { type: 'SERVERS_HEALTHY' }
    | { type: 'HEALTH_CHECK_TIMEOUT' }

    // Traffic management events
    | { type: 'TRAFFIC_ENABLED' }
    | { type: 'TRAFFIC_ENABLE_FAILED'; error: string }
    | { type: 'TRAFFIC_VALIDATED' }
    | { type: 'VALIDATION_FAILED'; error: string }

    // Blue draining events
    | { type: 'DRAIN_INITIATED' }
    | { type: 'DRAIN_COMPLETE' }
    | { type: 'DRAIN_TIMEOUT' }
    | { type: 'DRAIN_ISSUES'; error: string }

    // Blue decommission events
    | { type: 'LB_REMOVAL_SUCCESS' }
    | { type: 'LB_REMOVAL_FAILED'; error: string }
    | { type: 'BLUE_APP_STOPPED' }
    | { type: 'BLUE_APP_STOP_ERROR'; error: string }
    | { type: 'STOP_SUCCESS' }
    | { type: 'STOP_FAILED'; error: string }
    | { type: 'BLUE_APP_REMOVED' }
    | { type: 'BLUE_APP_REMOVAL_ERROR'; error: string }
    | { type: 'REMOVAL_SUCCESS' }
    | { type: 'REMOVAL_FAILED'; error: string }

    // Rollback events
    | { type: 'ROLLBACK_BLUE_TRAFFIC_RESTORED' }
    | { type: 'ROLLBACK_GREEN_CONFIG_REMOVED' }
    | { type: 'ROLLBACK_GREEN_APP_STOPPED' }
    | { type: 'ROLLBACK_GREEN_APP_REMOVED' }
    | { type: 'ROLLBACK_COMPLETE' }
    | { type: 'ROLLBACK_ERROR'; error: string }
    | { type: 'GREEN_LB_REMOVAL_ERROR'; error: string }

    // Completion events
    | { type: 'DEPLOYMENT_COMPLETE' }
    | { type: 'RESET' }
    | { type: 'MANUAL_INTERVENTION_COMPLETE' };

// The Blue-Green Update State Machine using setup
export const blueGreenUpdateMachine = setup({
    types: {
        context: {} as BlueGreenUpdateContext,
        events: {} as BlueGreenUpdateEvent,
        input: {} as BlueGreenUpdateContext
    },
    actions: {
        // Green deployment actions
        deployGreenApplicationContainers: ({ context, self }) => {
            deployApplicationContainers.execute(context, (event) => self.send(event));
        },

        monitorGreenContainerStartup: ({ context, self }) => {
            monitorContainerStartup.execute(context, (event) => self.send(event));
        },

        // Load balancer configuration actions
        initializeGreenLB: ({ context, self }) => {
            const logger = deploymentLogger();
            logger.info({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                newContainerId: context.newContainerId,
                containerIpAddress: context.containerIpAddress,
                containerPort: context.containerPort,
                currentState: 'initializingGreenLB'
            }, 'State machine: Entering initializeGreenLB action');

            // Map newContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.newContainerId
            };

            addContainerToLB.execute(contextWithContainerId, (event) => {
                logger.info({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    event,
                    currentState: 'initializingGreenLB'
                }, 'State machine: Received event from initializeGreenLB action');
                self.send(event);
            });
        },

        performGreenHealthChecks: ({ context, self }) => {
            // Map newContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.newContainerId
            };
            performHealthChecks.execute(contextWithContainerId, (event) => self.send(event));
        },

        // Traffic management actions
        openTrafficToGreen: ({ context, self }) => {
            // Map newContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.newContainerId
            };
            enableTraffic.execute(contextWithContainerId, (event) => self.send(event));
        },


        // Blue draining actions
        initiateBlueDrain: ({ context, self }) => {
            // Map newContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.newContainerId
            };
            initiateDrain.execute(contextWithContainerId, (event) => self.send(event));
        },

        setDrainStartTime: assign({
            drainStartTime: () => Date.now()
        }),

        monitorBlueDrain: ({ context, self }) => {
            // Start monitoring the drain status
            monitorDrain.execute(context, (event) => self.send(event));
        },

        // Blue decommission actions
        removeBlueFromLB: ({ context, self }) => {
            // Map oldContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.oldContainerId
            };
            removeContainerFromLB.execute(contextWithContainerId, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'LB_REMOVAL_FAILED',
                    error: (error instanceof Error ? error.message : String(error)) || 'Unknown error'
                });
            });
        },

        stopBlueApplication: ({ context, self }) => {
            // Map oldContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.oldContainerId
            };
            stopApplication.execute(contextWithContainerId, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'BLUE_APP_STOP_ERROR',
                    error: (error instanceof Error ? error.message : String(error)) || 'Unknown error'
                });
            });
        },

        removeBlueApplication: ({ context, self }) => {
            // Map oldContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.oldContainerId
            };
            removeApplication.execute(contextWithContainerId, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'BLUE_APP_REMOVAL_ERROR',
                    error: (error instanceof Error ? error.message : String(error)) || 'Unknown error'
                });
            });
        },

        // Rollback actions
        restoreBlueTraffic: ({ context, self }) => {
            // Map oldContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.oldContainerId
            };
            enableTraffic.execute(contextWithContainerId, (event) => {
                // Map the standard traffic events to rollback events
                if (event.type === 'TRAFFIC_ENABLED') {
                    self.send({ type: 'ROLLBACK_BLUE_TRAFFIC_RESTORED' });
                } else if (event.type === 'TRAFFIC_ENABLE_FAILED') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            });
        },

        removeGreenHAProxyConfig: ({ context, self }) => {
            // Map newContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.newContainerId
            };
            removeContainerFromLB.execute(contextWithContainerId, (event) => {
                // Map the standard LB removal events to rollback events
                if (event.type === 'LB_REMOVAL_SUCCESS') {
                    self.send({ type: 'ROLLBACK_GREEN_CONFIG_REMOVED' });
                } else if (event.type === 'LB_REMOVAL_FAILED') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({
                    type: 'ROLLBACK_ERROR',
                    error: (error instanceof Error ? error.message : String(error)) || 'Unknown error'
                });
            });
        },

        stopGreenApplication: ({ context, self }) => {
            // Map newContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.newContainerId
            };
            stopApplication.execute(contextWithContainerId, (event) => {
                // Map stop events to rollback events
                if (event.type === 'STOP_SUCCESS') {
                    self.send({ type: 'ROLLBACK_GREEN_APP_STOPPED' });
                } else if (event.type === 'STOP_FAILED') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({
                    type: 'ROLLBACK_ERROR',
                    error: (error instanceof Error ? error.message : String(error)) || 'Unknown error'
                });
            });
        },

        removeGreenApplication: ({ context, self }) => {
            // Map newContainerId to containerId for the action
            const contextWithContainerId = {
                ...context,
                containerId: context.newContainerId
            };
            removeApplication.execute(contextWithContainerId, (event) => {
                // Map removal events to rollback events
                if (event.type === 'REMOVAL_SUCCESS') {
                    self.send({ type: 'ROLLBACK_GREEN_APP_REMOVED' });
                } else if (event.type === 'REMOVAL_FAILED') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({
                    type: 'ROLLBACK_ERROR',
                    error: (error instanceof Error ? error.message : String(error)) || 'Unknown error'
                });
            });
        },

        // Monitoring and completion actions
        startExtendedMonitoring: assign({
            monitoringStartTime: () => Date.now()
        }),

        logDeploymentSuccess: ({ context }) => {
            logDeploymentSuccess.execute(context);
        },

        alertOperationsTeam: ({ context }) => {
            alertOperationsTeam.execute(context);
        },

        cleanupTempResources: ({ context }) => {
            cleanupTempResources.execute(context as unknown as CleanupContext);
        },

        cleanupFailedDeployment: async ({ context }) => {
            const logger = deploymentLogger();
            logger.warn({
                deploymentId: context.deploymentId,
                applicationName: context.applicationName,
                newContainerId: context.newContainerId?.slice(0, 12),
                error: context.error
            }, 'Attempting best-effort cleanup of failed deployment');

            // Best-effort cleanup - don't fail if any step fails
            try {
                // If we have a green container, try to remove it and its HAProxy config
                if (context.newContainerId) {
                    logger.info({
                        deploymentId: context.deploymentId,
                        containerId: context.newContainerId.slice(0, 12)
                    }, 'Attempting to clean up green container from failed deployment');

                    // Try to remove from HAProxy first
                    try {
                        const contextWithContainerId = {
                            ...context,
                            containerId: context.newContainerId
                        };
                        await removeContainerFromLB.execute(contextWithContainerId, () => {});
                        logger.info({
                            deploymentId: context.deploymentId,
                            containerId: context.newContainerId.slice(0, 12)
                        }, 'Removed green container from HAProxy');
                    } catch (lbError) {
                        logger.warn({
                            deploymentId: context.deploymentId,
                            containerId: context.newContainerId.slice(0, 12),
                            error: lbError instanceof Error ? lbError.message : 'Unknown error'
                        }, 'Failed to remove container from HAProxy during cleanup');
                    }

                    // Try to stop and remove the container
                    try {
                        const contextWithContainerId = {
                            ...context,
                            containerId: context.newContainerId
                        };
                        await stopApplication.execute(contextWithContainerId, () => {});
                        await removeApplication.execute(contextWithContainerId, () => {});
                        logger.info({
                            deploymentId: context.deploymentId,
                            containerId: context.newContainerId.slice(0, 12)
                        }, 'Stopped and removed green container');
                    } catch (containerError) {
                        logger.warn({
                            deploymentId: context.deploymentId,
                            containerId: context.newContainerId.slice(0, 12),
                            error: containerError instanceof Error ? containerError.message : 'Unknown error'
                        }, 'Failed to stop/remove container during cleanup');
                    }
                }

                logger.info({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName
                }, 'Failed deployment cleanup completed (best-effort)');
            } catch (error) {
                logger.error({
                    deploymentId: context.deploymentId,
                    applicationName: context.applicationName,
                    error: error instanceof Error ? error.message : 'Unknown error'
                }, 'Unexpected error during failed deployment cleanup');
            }
        },

        // Context management actions
        preserveErrorContext: assign({
            error: ({ event }) => {
                if ('error' in event) {
                    return event.error;
                }
                return undefined;
            }
        }),

        incrementRetryCount: assign({
            retryCount: ({ context }) => context.retryCount + 1
        }),

        resetState: assign(() => ({
            // Keep deployment identifiers and environment context
            // Only reset deployment state
            blueHealthy: false,
            greenHealthy: false,
            greenBackendConfigured: false,
            trafficOpenedToGreen: false,
            trafficValidated: false,
            blueDraining: false,
            blueDrained: false,
            validationErrors: 0,
            drainStartTime: undefined,
            monitoringStartTime: undefined,
            error: undefined,
            retryCount: 0,
            activeConnections: 0,
            newContainerId: undefined,
            containerIpAddress: undefined,
            containerPort: undefined,
        }))
    },
    guards: {
        greenContainersRunning: ({ context }) => {
            return context.greenHealthy;
        },

        greenServersHealthy: ({ context }) => {
            return context.greenHealthy && context.greenBackendConfigured;
        },

        trafficValidationPassed: ({ context }) => {
            return context.trafficValidated && context.validationErrors === 0;
        },

        blueConnectionsDrained: ({ context }) => {
            return context.activeConnections === 0;
        },

        drainTimeoutExceeded: ({ context }) => {
            if (!context.drainStartTime) return false;
            const elapsed = Date.now() - context.drainStartTime;
            return elapsed >= 120000; // 2 minutes
        },

        monitoringPeriodComplete: ({ context }) => {
            if (!context.monitoringStartTime) return false;
            const elapsed = Date.now() - context.monitoringStartTime;
            return elapsed >= 300000; // 5 minutes
        },

        canRetry: ({ context }) => {
            return context.retryCount < 3;
        }
    }
}).createMachine({
    id: 'blueGreenUpdate',
    initial: 'idle',
    context: ({ input }: { input: BlueGreenUpdateContext }) => ({
        // Use input data if provided, otherwise use defaults
        deploymentId: input?.deploymentId || "",
        configurationId: input?.configurationId || "",
        applicationName: input?.applicationName || "",
        dockerImage: input?.dockerImage || "",

        // User event tracking
        userEventId: input?.userEventId,

        // Environment context
        environmentId: input?.environmentId || "",
        environmentName: input?.environmentName || "",
        haproxyContainerId: input?.haproxyContainerId || "",
        haproxyNetworkName: input?.haproxyNetworkName || "",

        // Container state (always start with defaults)
        blueHealthy: false,
        greenHealthy: false,
        greenBackendConfigured: false,
        trafficOpenedToGreen: false,
        trafficValidated: false,
        blueDraining: false,
        blueDrained: false,
        validationErrors: 0,
        retryCount: 0,
        activeConnections: 0,
        oldContainerId: input?.oldContainerId,
        newContainerId: input?.newContainerId,
        containerName: input?.containerName,
        containerIpAddress: input?.containerIpAddress,
        containerPort: input?.containerPort,

        // Deployment metadata
        triggerType: input?.triggerType || "manual",
        triggeredBy: input?.triggeredBy,
        startTime: input?.startTime || Date.now(),

        // Configuration
        config: input?.config,

        // Source-agnostic configuration
        hostname: input?.hostname,
        enableSsl: input?.enableSsl,
        tlsCertificateId: input?.tlsCertificateId,
        certificateStatus: input?.certificateStatus,
        networkType: input?.networkType,
        healthCheckEndpoint: input?.healthCheckEndpoint,
        healthCheckInterval: input?.healthCheckInterval,
        healthCheckRetries: input?.healthCheckRetries,
        containerPorts: input?.containerPorts,
        containerVolumes: input?.containerVolumes,
        containerEnvironment: input?.containerEnvironment,
        containerLabels: input?.containerLabels,
        containerNetworks: input?.containerNetworks,
    }),

    states: {
        idle: {
            description: 'System is ready for deployment, no active deployment in progress',
            on: {
                START_DEPLOYMENT: {
                    target: 'deployingGreenApp'
                    // NOTE: Do NOT call resetState here - it would clear oldContainerId and other container tracking fields
                    // The context is already properly initialized from input when the actor is created
                }
            }
        },

        deployingGreenApp: {
            description: 'Deploying green application containers',
            entry: [
                ({ context }) => {
                    const logger = deploymentLogger();
                    logger.info({
                        deploymentId: context.deploymentId,
                        applicationName: context.applicationName,
                        dockerImage: context.dockerImage,
                        environmentName: context.environmentName,
                        oldContainerId: context.oldContainerId?.slice(0, 12)
                    }, 'State machine: Entering deployingGreenApp state');

                },
                'deployGreenApplicationContainers'
            ],
            on: {
                DEPLOYMENT_SUCCESS: {
                    target: 'waitingGreenReady',
                    actions: [
                        assign({
                            newContainerId: ({ event }) => {
                                if (event.type === 'DEPLOYMENT_SUCCESS') {
                                    return event.containerId;
                                }
                                return undefined;
                            },
                            containerName: ({ event }) => {
                                if (event.type === 'DEPLOYMENT_SUCCESS') {
                                    return event.containerName;
                                }
                                return undefined;
                            }
                        }),
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.info({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                containerId: 'containerId' in event ? event.containerId : 'unknown',
                                containerName: 'containerName' in event ? event.containerName : 'unknown'
                            }, 'State machine: DEPLOYMENT_SUCCESS - transitioning to waitingGreenReady');
                        }
                    ]
                },
                DEPLOYMENT_ERROR: {
                    target: 'failed',
                    actions: [
                        'preserveErrorContext',
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.error({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                error: 'error' in event ? event.error : 'Unknown error'
                            }, 'State machine: DEPLOYMENT_ERROR - transitioning to failed');
                        }
                    ]
                }
            }
        },

        waitingGreenReady: {
            description: 'Waiting for green application containers to be ready',
            entry: [
                ({ context }) => {
                    const logger = deploymentLogger();
                    logger.info({
                        deploymentId: context.deploymentId,
                        applicationName: context.applicationName,
                        newContainerId: context.newContainerId
                    }, 'State machine: Entering waitingGreenReady state');
                },
                'monitorGreenContainerStartup'
            ],
            on: {
                CONTAINERS_RUNNING: {
                    target: 'initializingGreenLB',
                    actions: [
                        assign({
                            greenHealthy: true,
                            containerIpAddress: ({ event }) => {
                                if (event.type === 'CONTAINERS_RUNNING' && 'containerIpAddress' in event) {
                                    return event.containerIpAddress;
                                }
                                return undefined;
                            },
                            containerPort: ({ event }) => {
                                if (event.type === 'CONTAINERS_RUNNING' && 'containerPort' in event) {
                                    return event.containerPort;
                                }
                                return undefined;
                            },
                            containerName: ({ event }) => {
                                if (event.type === 'CONTAINERS_RUNNING' && 'containerName' in event) {
                                    return event.containerName;
                                }
                                return undefined;
                            }
                        }),
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.info({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                containerIpAddress: 'containerIpAddress' in event ? event.containerIpAddress : 'unknown',
                                containerPort: 'containerPort' in event ? event.containerPort : 'unknown',
                                containerName: 'containerName' in event ? event.containerName : 'unknown'
                            }, 'State machine: CONTAINERS_RUNNING - transitioning to initializingGreenLB');
                        }
                    ]
                },
                STARTUP_TIMEOUT: {
                    target: 'rollbackRemovingGreenApp',
                    actions: [
                        assign({ error: 'Green container startup timeout' }),
                        ({ context }) => {
                            const logger = deploymentLogger();
                            logger.error({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName
                            }, 'State machine: STARTUP_TIMEOUT - transitioning to rollbackRemovingGreenApp');
                        }
                    ]
                }
            },
            after: {
                120000: { // 2 minute timeout
                    target: 'rollbackRemovingGreenApp',
                    actions: [
                        assign({ error: 'Green application startup timeout' }),
                        ({ context }) => {
                            const logger = deploymentLogger();
                            logger.error({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName
                            }, 'State machine: Startup timeout (120s) - transitioning to rollbackRemovingGreenApp');
                        }
                    ]
                }
            }
        },

        initializingGreenLB: {
            description: 'Preparing HAProxy configuration for green backend and registering servers',
            entry: [
                ({ context }) => {
                    const logger = deploymentLogger();
                    logger.info({
                        deploymentId: context.deploymentId,
                        applicationName: context.applicationName,
                        newContainerId: context.newContainerId,
                        containerIpAddress: context.containerIpAddress,
                        containerPort: context.containerPort,
                        environmentName: context.environmentName,
                        haproxyContainerId: context.haproxyContainerId,
                        config: context.config ? 'present' : 'missing'
                    }, 'State machine: Entering initializingGreenLB state');
                },
                'initializeGreenLB'
            ],
            on: {
                LB_CONFIGURED: {
                    target: 'healthCheckWait',
                    actions: [
                        assign({ greenBackendConfigured: true }),
                        ({ context }) => {
                            const logger = deploymentLogger();
                            logger.info({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                currentState: 'initializingGreenLB'
                            }, 'State machine: LB_CONFIGURED - transitioning to healthCheckWait');
                        }
                    ]
                },
                LB_CONFIG_ERROR: {
                    target: 'rollbackStoppingGreenApp',
                    actions: [
                        'preserveErrorContext',
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.error({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                error: 'error' in event ? event.error : 'Unknown error',
                                currentState: 'initializingGreenLB'
                            }, 'State machine: LB_CONFIG_ERROR - transitioning to rollbackStoppingGreenApp');
                        }
                    ]
                }
            }
        },

        healthCheckWait: {
            description: 'Waiting for green servers to become healthy',
            entry: 'performGreenHealthChecks',
            on: {
                SERVERS_HEALTHY: {
                    target: 'openingTraffic',
                    actions: assign({ greenHealthy: true })
                },
                HEALTH_CHECK_TIMEOUT: {
                    target: 'rollbackRemoveGreenHaproxyConfig',
                    actions: assign({ error: 'Green health check timeout' })
                }
            },
            after: {
                90000: { // 90 second timeout
                    target: 'rollbackRemoveGreenHaproxyConfig',
                    actions: assign({ error: 'Health check timeout after 90 seconds' })
                }
            }
        },

        openingTraffic: {
            description: 'Enabling traffic to green environment alongside blue',
            entry: 'openTrafficToGreen',
            on: {
                TRAFFIC_ENABLED: {
                    target: 'drainingBlue',
                    actions: assign({ trafficOpenedToGreen: true, trafficValidated: true })
                },
                TRAFFIC_ENABLE_FAILED: {
                    target: 'rollbackRemoveGreenHaproxyConfig',
                    actions: 'preserveErrorContext'
                }
            }
        },


        drainingBlue: {
            description: 'Initiating connection drain from blue environment',
            entry: ['initiateBlueDrain', 'setDrainStartTime'],
            on: {
                DRAIN_INITIATED: {
                    target: 'waitingForDrain',
                    actions: assign({ blueDraining: true })
                },
                DRAIN_ISSUES: {
                    target: 'rollbackRestoreBlueTraffic',
                    actions: 'preserveErrorContext'
                }
            }
        },

        waitingForDrain: {
            description: 'Waiting for all blue connections to close',
            entry: 'monitorBlueDrain',
            on: {
                DRAIN_COMPLETE: {
                    target: 'decommissioningBlueLB',
                    actions: assign({
                        blueDrained: true,
                        activeConnections: 0
                    })
                },
                DRAIN_TIMEOUT: {
                    target: 'rollbackRestoreBlueTraffic',
                    actions: assign({ error: 'Blue connection drain timeout' })
                },
                DRAIN_ISSUES: {
                    target: 'rollbackRestoreBlueTraffic',
                    actions: 'preserveErrorContext'
                }
            },
            after: {
                120000: { // 2 minute drain timeout
                    target: 'rollbackRestoreBlueTraffic',
                    actions: assign({ error: 'Forced drain timeout after 2 minutes' })
                }
            }
        },

        decommissioningBlueLB: {
            description: 'Removing blue backend from HAProxy configuration',
            entry: 'removeBlueFromLB',
            on: {
                LB_REMOVAL_SUCCESS: {
                    target: 'stoppingBlueApp'
                },
                LB_REMOVAL_FAILED: {
                    target: 'stoppingBlueApp',
                    actions: [
                        assign({ error: 'Unable to remove blue backend (Non-Critical)' }),
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.warn({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                error: 'error' in event ? event.error : 'Unknown error'
                            }, 'Blue LB removal failed post-PONR - continuing blue cleanup (green is live)');
                        }
                    ]
                }
            }
        },

        stoppingBlueApp: {
            description: 'Stopping blue application containers',
            entry: 'stopBlueApplication',
            on: {
                STOP_SUCCESS: {
                    target: 'removingBlueApp'
                },
                BLUE_APP_STOP_ERROR: {
                    target: 'removingBlueApp',
                    actions: [
                        assign({ error: 'Blue app stop failed (Non-Critical)' }),
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.warn({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                oldContainerId: context.oldContainerId?.slice(0, 12),
                                error: 'error' in event ? event.error : 'Unknown error'
                            }, 'Blue app stop failed post-PONR - continuing to removal (green is live)');
                        }
                    ]
                },
                STOP_FAILED: {
                    target: 'removingBlueApp',
                    actions: [
                        assign({ error: 'Blue app stop failed (Non-Critical)' }),
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.warn({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                oldContainerId: context.oldContainerId?.slice(0, 12),
                                error: 'error' in event ? event.error : 'Unknown error'
                            }, 'Blue app stop failed post-PONR - continuing to removal (green is live)');
                        }
                    ]
                }
            }
        },

        removingBlueApp: {
            description: 'Removing blue application resources',
            entry: 'removeBlueApplication',
            on: {
                REMOVAL_SUCCESS: {
                    target: 'completed'
                },
                BLUE_APP_REMOVAL_ERROR: {
                    target: 'completed',
                    actions: [
                        assign({ error: 'Blue app removal failed (Non-Critical)' }),
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.warn({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                oldContainerId: context.oldContainerId?.slice(0, 12),
                                error: 'error' in event ? event.error : 'Unknown error'
                            }, 'Blue app removal failed post-PONR - completing deployment (green is live)');
                        }
                    ]
                },
                REMOVAL_FAILED: {
                    target: 'completed',
                    actions: [
                        assign({ error: 'Blue app removal failed (Non-Critical)' }),
                        ({ context, event }) => {
                            const logger = deploymentLogger();
                            logger.warn({
                                deploymentId: context.deploymentId,
                                applicationName: context.applicationName,
                                oldContainerId: context.oldContainerId?.slice(0, 12),
                                error: 'error' in event ? event.error : 'Unknown error'
                            }, 'Blue app removal failed post-PONR - completing deployment (green is live)');
                        }
                    ]
                }
            }
        },

        // Rollback states
        rollbackRestoreBlueTraffic: {
            description: 'Restoring traffic to the blue application during rollback',
            entry: 'restoreBlueTraffic',
            on: {
                ROLLBACK_BLUE_TRAFFIC_RESTORED: {
                    target: 'rollbackRemoveGreenHaproxyConfig'
                },
                ROLLBACK_ERROR: {
                    target: 'rollbackRemoveGreenHaproxyConfig',
                    actions: 'preserveErrorContext'
                }
            }
        },

        rollbackRemoveGreenHaproxyConfig: {
            description: 'Remove green haproxy server and backends during rollback',
            entry: 'removeGreenHAProxyConfig',
            on: {
                ROLLBACK_GREEN_CONFIG_REMOVED: {
                    target: 'rollbackStoppingGreenApp'
                },
                ROLLBACK_ERROR: {
                    target: 'failed',
                    actions: assign({ error: 'Cannot rollback green config' })
                }
            }
        },

        rollbackStoppingGreenApp: {
            description: 'Stopping failed green application containers during rollback',
            entry: 'stopGreenApplication',
            on: {
                ROLLBACK_GREEN_APP_STOPPED: {
                    target: 'rollbackRemovingGreenApp'
                },
                ROLLBACK_ERROR: {
                    target: 'rollbackRemovingGreenApp',
                    actions: assign({ error: 'Green app stop failed - continuing cleanup' })
                }
            }
        },

        rollbackRemovingGreenApp: {
            description: 'Cleaning up green application resources during rollback',
            entry: 'removeGreenApplication',
            on: {
                ROLLBACK_GREEN_APP_REMOVED: {
                    target: 'rollbackComplete'
                },
                ROLLBACK_ERROR: {
                    target: 'rollbackComplete',
                    actions: assign({ error: 'Green app removal had errors - rollback completed with warnings' })
                }
            }
        },

        rollbackComplete: {
            type: 'final' as const,
            description: 'Rollback successfully completed - deployment failed but cleaned up',
            entry: ['alertOperationsTeam', 'cleanupTempResources']
        },

        completed: {
            type: 'final' as const,
            description: 'Deployment successfully completed',
            entry: ['logDeploymentSuccess', 'cleanupTempResources'],
            on: {
                RESET: {
                    target: 'idle',
                    actions: 'resetState'
                }
            }
        },

        failed: {
            type: 'final' as const,
            description: 'Deployment failed - attempting best-effort cleanup',
            entry: [
                'alertOperationsTeam',
                'cleanupFailedDeployment'
            ]
        }
    }
});
