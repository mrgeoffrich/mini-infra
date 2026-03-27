import { assign, setup } from 'xstate';
import { DeploymentConfig } from '@mini-infra/types';
import { DeployApplicationContainers } from './actions/deploy-application-containers';
import { MonitorContainerStartup } from './actions/monitor-container-startup';
import { AddContainerToLB } from './actions/add-container-to-lb';
import { PerformHealthChecks } from './actions/perform-health-checks';
import { ConfigureFrontend } from './actions/configure-frontend';
import { ConfigureDNS } from './actions/configure-dns';
import { EnableTraffic } from './actions/enable-traffic';
import { LogDeploymentSuccess } from './actions/log-deployment-success';
import { AlertOperationsTeam } from './actions/alert-operations-team';
import { CleanupTempResources } from './actions/cleanup-temp-resources';
import { RemoveContainerFromLB } from './actions/remove-container-from-lb';
import { RemoveFrontend } from './actions/remove-frontend';
import { RemoveDNS } from './actions/remove-dns';
import { StopApplication } from './actions/stop-application';
import { RemoveApplication } from './actions/remove-application';

// Create instances of action classes
const deployApplicationContainers = new DeployApplicationContainers();
const monitorContainerStartup = new MonitorContainerStartup();
const addContainerToLB = new AddContainerToLB();
const performHealthChecks = new PerformHealthChecks();
const configureFrontend = new ConfigureFrontend();
const configureDNS = new ConfigureDNS();
const enableTraffic = new EnableTraffic();
const logDeploymentSuccess = new LogDeploymentSuccess();
const alertOperationsTeam = new AlertOperationsTeam();
const cleanupTempResources = new CleanupTempResources();
const removeContainerFromLB = new RemoveContainerFromLB();
const removeFrontend = new RemoveFrontend();
const removeDNS = new RemoveDNS();
const stopApplication = new StopApplication();
const removeApplication = new RemoveApplication();

// Types for context and events
interface InitialDeploymentContext {
    // Deployment identifiers
    deploymentId: string;
    configurationId: string;
    deploymentConfigId: string;
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
    containerId?: string;
    containerName?: string;
    containerIpAddress?: string;
    containerPort?: number;
    applicationReady: boolean;
    haproxyConfigured: boolean;
    healthChecksPassed: boolean;
    frontendConfigured: boolean;
    dnsConfigured: boolean;
    trafficEnabled: boolean;
    validationErrors: number;
    error?: string;
    retryCount: number;
    frontendName?: string;
    dnsRecordId?: string;

    // Deployment metadata
    triggerType: string;
    triggeredBy?: string;
    startTime: number;

    // Configuration
    config?: DeploymentConfig;

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
    containerPorts?: { containerPort: number; hostPort: number; protocol: string }[];
    containerVolumes?: string[];
    containerEnvironment?: Record<string, string>;
    containerLabels?: Record<string, string>;
    containerNetworks?: string[];
}

type InitialDeploymentEvent =
    | { type: 'START_DEPLOYMENT' }
    | { type: 'DEPLOYMENT_SUCCESS'; containerId: string; containerName?: string }
    | { type: 'DEPLOYMENT_ERROR'; error: string }
    | { type: 'CONTAINERS_RUNNING'; containerIpAddress?: string; containerPort?: number; containerName?: string }
    | { type: 'STARTUP_TIMEOUT'; error?: string }
    | { type: 'LB_CONFIGURED' }
    | { type: 'LB_CONFIG_ERROR'; error: string }
    | { type: 'SERVERS_HEALTHY' }
    | { type: 'HEALTH_CHECK_TIMEOUT'; error?: string }
    | { type: 'FRONTEND_CONFIGURED'; frontendName?: string; hostname?: string; backendName?: string }
    | { type: 'FRONTEND_CONFIG_SKIPPED'; message?: string }
    | { type: 'FRONTEND_CONFIG_ERROR'; error: string }
    | { type: 'DNS_CONFIGURED'; dnsRecordId?: string; hostname?: string }
    | { type: 'DNS_CONFIG_SKIPPED'; message?: string; networkType?: string }
    | { type: 'DNS_CONFIG_ERROR'; error: string }
    | { type: 'TRAFFIC_ENABLED' }
    | { type: 'TRAFFIC_ENABLE_FAILED'; error: string }
    | { type: 'TRAFFIC_STABLE' }
    | { type: 'CRITICAL_ISSUES'; error: string }
    | { type: 'RESET' }
    | { type: 'MANUAL_INTERVENTION_COMPLETE' }
    // Rollback events
    | { type: 'ROLLBACK_DNS_REMOVED' }
    | { type: 'ROLLBACK_DNS_REMOVAL_SKIPPED' }
    | { type: 'ROLLBACK_FRONTEND_REMOVED' }
    | { type: 'ROLLBACK_FRONTEND_REMOVAL_SKIPPED' }
    | { type: 'ROLLBACK_CONFIG_REMOVED' }
    | { type: 'ROLLBACK_APP_STOPPED' }
    | { type: 'ROLLBACK_APP_REMOVED' }
    | { type: 'ROLLBACK_ERROR'; error: string };

// The Initial Deployment State Machine using setup
export const initialDeploymentMachine = setup({
    types: {
        context: {} as InitialDeploymentContext,
        events: {} as InitialDeploymentEvent
    },
    actions: {
        deployApplicationContainers: ({ context, self }) => {
            // Execute async action with event callback
            deployApplicationContainers.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'DEPLOYMENT_ERROR',
                    error: error.message || 'Unknown error'
                });
            });
        },
        monitorContainerStartup: ({ context, self }) => {
            // Execute async action with event callback
            monitorContainerStartup.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'STARTUP_TIMEOUT',
                    error: error.message || 'Unknown error'
                });
            });
        },
        initializeHAProxy: ({ context, self }) => {
            // Execute async action with event callback
            addContainerToLB.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'LB_CONFIG_ERROR',
                    error: error.message || 'Unknown error'
                });
            });
        },
        performHealthChecks: ({ context, self }) => {
            // Execute async action with event callback
            performHealthChecks.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'HEALTH_CHECK_TIMEOUT',
                    error: error.message || 'Unknown error'
                });
            });
        },
        configureFrontend: ({ context, self }) => {
            // Execute async action with event callback
            configureFrontend.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'FRONTEND_CONFIG_ERROR',
                    error: error.message || 'Unknown error'
                });
            });
        },
        configureDNS: ({ context, self }) => {
            // Execute async action with event callback
            configureDNS.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'DNS_CONFIG_ERROR',
                    error: error.message || 'Unknown error'
                });
            });
        },
        enableTraffic: ({ context, self }) => {
            // Execute async action with event callback
            enableTraffic.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'TRAFFIC_ENABLE_FAILED',
                    error: error.message || 'Unknown error'
                });
            });
        },
        logDeploymentSuccess: ({ context }) => {
            logDeploymentSuccess.execute(context);
        },
        alertOperationsTeam: ({ context }) => {
            alertOperationsTeam.execute(context);
        },
        cleanupTempResources: ({ context }) => {
            cleanupTempResources.execute(context);
        },
        rollbackRemoveDNS: ({ context, self }) => {
            removeDNS.execute(context, (event) => {
                if (event.type === 'DNS_REMOVED') {
                    self.send({ type: 'ROLLBACK_DNS_REMOVED' });
                } else if (event.type === 'DNS_REMOVAL_SKIPPED') {
                    self.send({ type: 'ROLLBACK_DNS_REMOVAL_SKIPPED' });
                } else if (event.type === 'DNS_REMOVAL_ERROR') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({ type: 'ROLLBACK_ERROR', error: error.message || 'Unknown error' });
            });
        },
        rollbackRemoveFrontend: ({ context, self }) => {
            removeFrontend.execute(context, (event) => {
                if (event.type === 'FRONTEND_REMOVED') {
                    self.send({ type: 'ROLLBACK_FRONTEND_REMOVED' });
                } else if (event.type === 'FRONTEND_REMOVAL_SKIPPED') {
                    self.send({ type: 'ROLLBACK_FRONTEND_REMOVAL_SKIPPED' });
                } else if (event.type === 'FRONTEND_REMOVAL_ERROR') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({ type: 'ROLLBACK_ERROR', error: error.message || 'Unknown error' });
            });
        },
        rollbackRemoveHAProxyConfig: ({ context, self }) => {
            removeContainerFromLB.execute(context, (event) => {
                if (event.type === 'LB_REMOVAL_SUCCESS') {
                    self.send({ type: 'ROLLBACK_CONFIG_REMOVED' });
                } else if (event.type === 'LB_REMOVAL_FAILED') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({ type: 'ROLLBACK_ERROR', error: error.message || 'Unknown error' });
            });
        },
        rollbackStopApplication: ({ context, self }) => {
            stopApplication.execute(context, (event) => {
                if (event.type === 'STOP_SUCCESS') {
                    self.send({ type: 'ROLLBACK_APP_STOPPED' });
                } else if (event.type === 'STOP_FAILED') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({ type: 'ROLLBACK_ERROR', error: error.message || 'Unknown error' });
            });
        },
        rollbackRemoveApplication: ({ context, self }) => {
            removeApplication.execute(context, (event) => {
                if (event.type === 'REMOVAL_SUCCESS') {
                    self.send({ type: 'ROLLBACK_APP_REMOVED' });
                } else if (event.type === 'REMOVAL_FAILED') {
                    self.send({ type: 'ROLLBACK_ERROR', error: event.error });
                } else {
                    self.send(event);
                }
            }).catch((error) => {
                self.send({ type: 'ROLLBACK_ERROR', error: error.message || 'Unknown error' });
            });
        },
        preserveErrorContext: assign({
            error: ({ event }) => {
                if ('error' in event) {
                    return event.error;
                }
                return undefined;
            }
        }),
        resetState: assign(() => ({
            // Keep deployment identifiers and environment context
            // Only reset deployment state
            containerId: undefined,
            containerName: undefined,
            containerIpAddress: undefined,
            containerPort: undefined,
            applicationReady: false,
            haproxyConfigured: false,
            healthChecksPassed: false,
            frontendConfigured: false,
            dnsConfigured: false,
            trafficEnabled: false,
            validationErrors: 0,
            error: undefined,
            retryCount: 0,
            frontendName: undefined,
            dnsRecordId: undefined
        }))
    },
    guards: {
        containersRunning: ({ context }) => {
            return context.applicationReady;
        },
        serversHealthy: ({ context }) => {
            return context.healthChecksPassed;
        }
    }
}).createMachine({
    id: 'initialDeployment',
    initial: 'idle',
    context: ({ input }) => {
        const deploymentInput = input as InitialDeploymentContext | undefined;
        return {
        // Use input values if provided, otherwise use defaults
        deploymentId: deploymentInput?.deploymentId || "",
        configurationId: deploymentInput?.configurationId || "",
        deploymentConfigId: deploymentInput?.deploymentConfigId || deploymentInput?.configurationId || "",
        applicationName: deploymentInput?.applicationName || "",
        dockerImage: deploymentInput?.dockerImage || "",

        // User event tracking
        userEventId: deploymentInput?.userEventId,

        // Environment context
        environmentId: deploymentInput?.environmentId || "",
        environmentName: deploymentInput?.environmentName || "",
        haproxyContainerId: deploymentInput?.haproxyContainerId || "",
        haproxyNetworkName: deploymentInput?.haproxyNetworkName || "",

        // Container state
        containerId: deploymentInput?.containerId,
        containerName: deploymentInput?.containerName,
        containerIpAddress: deploymentInput?.containerIpAddress,
        containerPort: deploymentInput?.containerPort,
        applicationReady: deploymentInput?.applicationReady || false,
        haproxyConfigured: deploymentInput?.haproxyConfigured || false,
        healthChecksPassed: deploymentInput?.healthChecksPassed || false,
        frontendConfigured: deploymentInput?.frontendConfigured || false,
        dnsConfigured: deploymentInput?.dnsConfigured || false,
        trafficEnabled: deploymentInput?.trafficEnabled || false,
        validationErrors: deploymentInput?.validationErrors || 0,
        error: deploymentInput?.error,
        retryCount: deploymentInput?.retryCount || 0,
        frontendName: deploymentInput?.frontendName,
        dnsRecordId: deploymentInput?.dnsRecordId,

        // Deployment metadata
        triggerType: deploymentInput?.triggerType || "manual",
        triggeredBy: deploymentInput?.triggeredBy,
        startTime: deploymentInput?.startTime || Date.now(),

        // Configuration
        config: deploymentInput?.config,

        // Source-agnostic configuration
        hostname: deploymentInput?.hostname,
        enableSsl: deploymentInput?.enableSsl,
        tlsCertificateId: deploymentInput?.tlsCertificateId,
        certificateStatus: deploymentInput?.certificateStatus,
        networkType: deploymentInput?.networkType,
        healthCheckEndpoint: deploymentInput?.healthCheckEndpoint,
        healthCheckInterval: deploymentInput?.healthCheckInterval,
        healthCheckRetries: deploymentInput?.healthCheckRetries,
        containerPorts: deploymentInput?.containerPorts,
        containerVolumes: deploymentInput?.containerVolumes,
        containerEnvironment: deploymentInput?.containerEnvironment,
        containerLabels: deploymentInput?.containerLabels,
        containerNetworks: deploymentInput?.containerNetworks,
        };
    },

    states: {
        idle: {
            description: 'System is ready for deployment, no active deployment in progress',
            on: {
                START_DEPLOYMENT: {
                    target: 'deployingInitialApp',
                    actions: 'resetState'
                }
            }
        },

        deployingInitialApp: {
            description: 'Deploying application containers for first time',
            entry: 'deployApplicationContainers',
            on: {
                DEPLOYMENT_SUCCESS: {
                    target: 'waitingAppReady',
                    actions: assign({
                        containerId: ({ event }) => {
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
                    })
                },
                DEPLOYMENT_ERROR: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            }
        },

        waitingAppReady: {
            description: 'Waiting for initial application containers to be ready',
            entry: 'monitorContainerStartup',
            on: {
                CONTAINERS_RUNNING: {
                    target: 'initializingFirstLB',
                    actions: assign({
                        applicationReady: true,
                        containerIpAddress: ({ event }) => {
                            if (event.type === 'CONTAINERS_RUNNING') {
                                return event.containerIpAddress;
                            }
                            return undefined;
                        },
                        containerPort: ({ event }) => {
                            if (event.type === 'CONTAINERS_RUNNING') {
                                return event.containerPort;
                            }
                            return undefined;
                        },
                        containerName: ({ event }) => {
                            if (event.type === 'CONTAINERS_RUNNING') {
                                return event.containerName;
                            }
                            return undefined;
                        }
                    })
                },
                STARTUP_TIMEOUT: {
                    target: 'rollbackStoppingApp',
                    actions: assign({ error: 'Container startup timeout' })
                }
            },
            after: {
                120000: { // 2 minute timeout
                    target: 'rollbackStoppingApp',
                    actions: assign({ error: 'Application startup timeout' })
                }
            }
        },

        initializingFirstLB: {
            description: 'Setting up HAProxy for first deployment',
            entry: 'initializeHAProxy',
            on: {
                LB_CONFIGURED: {
                    target: 'initialHealthCheck',
                    actions: assign({ haproxyConfigured: true })
                },
                LB_CONFIG_ERROR: {
                    target: 'rollbackRemoveHaproxyConfig',
                    actions: 'preserveErrorContext'
                }
            }
        },

        initialHealthCheck: {
            description: 'Waiting for initial servers to become healthy',
            entry: 'performHealthChecks',
            on: {
                SERVERS_HEALTHY: {
                    target: 'configuringFrontend',
                    actions: assign({ healthChecksPassed: true })
                },
                HEALTH_CHECK_TIMEOUT: {
                    target: 'rollbackRemoveHaproxyConfig',
                    actions: assign({ error: 'Health check timeout' })
                }
            },
            after: {
                90000: { // 90 second timeout
                    target: 'rollbackRemoveHaproxyConfig',
                    actions: assign({ error: 'Health check timeout after 90 seconds' })
                }
            }
        },

        configuringFrontend: {
            description: 'Configuring HAProxy frontend with hostname routing',
            entry: 'configureFrontend',
            on: {
                FRONTEND_CONFIGURED: {
                    target: 'configuringDNS',
                    actions: assign({
                        frontendConfigured: true,
                        frontendName: ({ event }) => {
                            if (event.type === 'FRONTEND_CONFIGURED') {
                                return event.frontendName;
                            }
                            return undefined;
                        }
                    })
                },
                FRONTEND_CONFIG_SKIPPED: {
                    target: 'configuringDNS',
                    actions: assign({ frontendConfigured: false })
                },
                FRONTEND_CONFIG_ERROR: {
                    target: 'rollbackRemoveFrontend',
                    actions: 'preserveErrorContext'
                }
            }
        },

        configuringDNS: {
            description: 'Configuring DNS records for deployment',
            entry: 'configureDNS',
            on: {
                DNS_CONFIGURED: {
                    target: 'enablingTraffic',
                    actions: assign({
                        dnsConfigured: true,
                        dnsRecordId: ({ event }) => {
                            if (event.type === 'DNS_CONFIGURED') {
                                return event.dnsRecordId;
                            }
                            return undefined;
                        }
                    })
                },
                DNS_CONFIG_SKIPPED: {
                    target: 'enablingTraffic',
                    actions: assign({ dnsConfigured: false })
                },
                DNS_CONFIG_ERROR: {
                    target: 'rollbackRemoveDNS',
                    actions: 'preserveErrorContext'
                }
            }
        },

        enablingTraffic: {
            description: 'Enabling traffic for the first time',
            entry: 'enableTraffic',
            on: {
                TRAFFIC_ENABLED: {
                    target: 'completed',
                    actions: assign({ trafficEnabled: true })
                },
                TRAFFIC_ENABLE_FAILED: {
                    target: 'rollbackRemoveDNS',
                    actions: 'preserveErrorContext'
                }
            }
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

        // Rollback states - clean up in reverse order of deployment progress
        rollbackRemoveDNS: {
            description: 'Removing DNS records during rollback',
            entry: 'rollbackRemoveDNS',
            on: {
                ROLLBACK_DNS_REMOVED: {
                    target: 'rollbackRemoveFrontend'
                },
                ROLLBACK_DNS_REMOVAL_SKIPPED: {
                    target: 'rollbackRemoveFrontend'
                },
                ROLLBACK_ERROR: {
                    target: 'rollbackRemoveFrontend',
                    actions: assign({ error: 'DNS removal had errors - continuing rollback' })
                }
            }
        },

        rollbackRemoveFrontend: {
            description: 'Removing HAProxy frontend configuration during rollback',
            entry: 'rollbackRemoveFrontend',
            on: {
                ROLLBACK_FRONTEND_REMOVED: {
                    target: 'rollbackRemoveHaproxyConfig'
                },
                ROLLBACK_FRONTEND_REMOVAL_SKIPPED: {
                    target: 'rollbackRemoveHaproxyConfig'
                },
                ROLLBACK_ERROR: {
                    target: 'rollbackRemoveHaproxyConfig',
                    actions: assign({ error: 'Frontend removal had errors - continuing rollback' })
                }
            }
        },

        rollbackRemoveHaproxyConfig: {
            description: 'Removing HAProxy backend and server configuration during rollback',
            entry: 'rollbackRemoveHAProxyConfig',
            on: {
                ROLLBACK_CONFIG_REMOVED: {
                    target: 'rollbackStoppingApp'
                },
                ROLLBACK_ERROR: {
                    target: 'failed',
                    actions: assign({ error: 'Cannot rollback HAProxy config' })
                }
            }
        },

        rollbackStoppingApp: {
            description: 'Stopping application container during rollback',
            entry: 'rollbackStopApplication',
            on: {
                ROLLBACK_APP_STOPPED: {
                    target: 'rollbackRemovingApp'
                },
                ROLLBACK_ERROR: {
                    target: 'rollbackRemovingApp',
                    actions: assign({ error: 'App stop failed - continuing cleanup' })
                }
            }
        },

        rollbackRemovingApp: {
            description: 'Removing application container during rollback',
            entry: 'rollbackRemoveApplication',
            on: {
                ROLLBACK_APP_REMOVED: {
                    target: 'rollbackComplete'
                },
                ROLLBACK_ERROR: {
                    target: 'rollbackComplete',
                    actions: assign({ error: 'App removal had errors - rollback completed with warnings' })
                }
            }
        },

        rollbackComplete: {
            type: 'final' as const,
            description: 'Rollback completed - deployment failed but infrastructure cleaned up',
            entry: ['alertOperationsTeam', 'cleanupTempResources']
        },

        failed: {
            type: 'final' as const,
            description: 'Deployment failed, manual intervention required',
            entry: 'alertOperationsTeam'
        }
    }
});
