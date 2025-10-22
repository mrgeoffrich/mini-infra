import { assign, setup } from 'xstate';
import { DeploymentConfig } from '@mini-infra/types';
import { DeployApplicationContainers } from './actions/deploy-application-containers';
import { MonitorContainerStartup } from './actions/monitor-container-startup';
import { AddContainerToLB } from './actions/add-container-to-lb';
import { PerformHealthChecks } from './actions/perform-health-checks';
import { ConfigureFrontend } from './actions/configure-frontend';
import { ConfigureDNS } from './actions/configure-dns';
import { EnableTraffic } from './actions/enable-traffic';
import { ValidateTraffic } from './actions/validate-traffic';
import { LogDeploymentSuccess } from './actions/log-deployment-success';
import { AlertOperationsTeam } from './actions/alert-operations-team';
import { CleanupTempResources } from './actions/cleanup-temp-resources';

// Create instances of action classes
const deployApplicationContainers = new DeployApplicationContainers();
const monitorContainerStartup = new MonitorContainerStartup();
const addContainerToLB = new AddContainerToLB();
const performHealthChecks = new PerformHealthChecks();
const configureFrontend = new ConfigureFrontend();
const configureDNS = new ConfigureDNS();
const enableTraffic = new EnableTraffic();
const validateTraffic = new ValidateTraffic();
const logDeploymentSuccess = new LogDeploymentSuccess();
const alertOperationsTeam = new AlertOperationsTeam();
const cleanupTempResources = new CleanupTempResources();

// Types for context and events
interface InitialDeploymentContext {
    // Deployment identifiers
    deploymentId: string;
    configurationId: string;
    applicationName: string;
    dockerImage: string;

    // Environment context
    environmentId: string;
    environmentName: string;
    haproxyContainerId: string;
    haproxyNetworkName: string;

    // Container state
    containerId?: string;
    containerIpAddress?: string;
    containerPort?: number;
    applicationReady: boolean;
    haproxyConfigured: boolean;
    healthChecksPassed: boolean;
    frontendConfigured: boolean;
    dnsConfigured: boolean;
    frontendName?: string;
    trafficEnabled: boolean;
    validationErrors: number;
    error?: string;
    retryCount: number;

    // Deployment metadata
    triggerType: string;
    triggeredBy?: string;
    startTime: number;

    // Configuration
    config?: DeploymentConfig;
}

type InitialDeploymentEvent =
    | { type: 'START_DEPLOYMENT' }
    | { type: 'DEPLOYMENT_SUCCESS'; containerId: string }
    | { type: 'DEPLOYMENT_ERROR'; error: string }
    | { type: 'CONTAINERS_RUNNING'; containerIpAddress?: string; containerPort?: number }
    | { type: 'STARTUP_TIMEOUT'; error?: string }
    | { type: 'LB_CONFIGURED' }
    | { type: 'LB_CONFIG_ERROR'; error: string }
    | { type: 'SERVERS_HEALTHY' }
    | { type: 'HEALTH_CHECK_TIMEOUT'; error?: string }
    | { type: 'FRONTEND_CONFIGURED'; frontendName?: string }
    | { type: 'FRONTEND_CONFIG_ERROR'; error: string }
    | { type: 'DNS_CONFIGURED' }
    | { type: 'DNS_CONFIG_SKIPPED' }
    | { type: 'DNS_CONFIG_ERROR'; error: string }
    | { type: 'TRAFFIC_ENABLED' }
    | { type: 'TRAFFIC_ENABLE_FAILED'; error: string }
    | { type: 'TRAFFIC_STABLE' }
    | { type: 'CRITICAL_ISSUES'; error: string }
    | { type: 'RESET' }
    | { type: 'MANUAL_INTERVENTION_COMPLETE' };

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
        configureFrontendAction: ({ context, self }) => {
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
        configureDNSAction: ({ context, self }) => {
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
        validateTraffic: ({ context, self }) => {
            // Execute async action with event callback
            validateTraffic.execute(context, (event) => {
                self.send(event);
            }).catch((error) => {
                self.send({
                    type: 'CRITICAL_ISSUES',
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
            containerIpAddress: undefined,
            containerPort: undefined,
            applicationReady: false,
            haproxyConfigured: false,
            healthChecksPassed: false,
            frontendConfigured: false,
            dnsConfigured: false,
            frontendName: undefined,
            trafficEnabled: false,
            validationErrors: 0,
            error: undefined,
            retryCount: 0
        }))
    },
    guards: {
        containersRunning: ({ context }) => {
            return context.applicationReady;
        },
        serversHealthy: ({ context }) => {
            return context.healthChecksPassed;
        },
        trafficStable: ({ context }) => {
            return context.validationErrors === 0;
        },
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
        applicationName: deploymentInput?.applicationName || "",
        dockerImage: deploymentInput?.dockerImage || "",

        // Environment context
        environmentId: deploymentInput?.environmentId || "",
        environmentName: deploymentInput?.environmentName || "",
        haproxyContainerId: deploymentInput?.haproxyContainerId || "",
        haproxyNetworkName: deploymentInput?.haproxyNetworkName || "",

        // Container state
        containerId: deploymentInput?.containerId,
        containerIpAddress: deploymentInput?.containerIpAddress,
        containerPort: deploymentInput?.containerPort,
        applicationReady: deploymentInput?.applicationReady || false,
        haproxyConfigured: deploymentInput?.haproxyConfigured || false,
        healthChecksPassed: deploymentInput?.healthChecksPassed || false,
        trafficEnabled: deploymentInput?.trafficEnabled || false,
        validationErrors: deploymentInput?.validationErrors || 0,
        error: deploymentInput?.error,
        retryCount: deploymentInput?.retryCount || 0,

        // Deployment metadata
        triggerType: deploymentInput?.triggerType || "manual",
        triggeredBy: deploymentInput?.triggeredBy,
        startTime: deploymentInput?.startTime || Date.now(),

        // Configuration
        config: deploymentInput?.config,
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
                        }
                    })
                },
                STARTUP_TIMEOUT: {
                    target: 'failed',
                    actions: assign({ error: 'Container startup timeout' })
                }
            },
            after: {
                120000: { // 2 minute timeout
                    target: 'failed',
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
                    target: 'failed',
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
                    target: 'failed',
                    actions: assign({ error: 'Health check timeout' })
                }
            },
            after: {
                90000: { // 90 second timeout
                    target: 'failed',
                    actions: assign({ error: 'Health check timeout after 90 seconds' })
                }
            }
        },

        configuringFrontend: {
            description: 'Configuring HAProxy frontend with hostname routing',
            entry: 'configureFrontendAction',
            on: {
                FRONTEND_CONFIGURED: {
                    target: 'configuringDNS',
                    actions: assign({
                        frontendConfigured: true,
                        frontendName: ({ event }) => event.frontendName
                    })
                },
                FRONTEND_CONFIG_ERROR: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            }
        },

        configuringDNS: {
            description: 'Configuring DNS records for deployment',
            entry: 'configureDNSAction',
            on: {
                DNS_CONFIGURED: {
                    target: 'enablingTraffic',
                    actions: assign({ dnsConfigured: true })
                },
                DNS_CONFIG_SKIPPED: {
                    target: 'enablingTraffic',
                    actions: assign({ dnsConfigured: true })
                },
                DNS_CONFIG_ERROR: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            }
        },

        enablingTraffic: {
            description: 'Enabling traffic for the first time',
            entry: 'enableTraffic',
            on: {
                TRAFFIC_ENABLED: {
                    target: 'validatingInitial',
                    actions: assign({ trafficEnabled: true })
                },
                TRAFFIC_ENABLE_FAILED: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            }
        },

        validatingInitial: {
            description: 'Validating the initial deployment',
            entry: 'validateTraffic',
            on: {
                TRAFFIC_STABLE: {
                    target: 'completed'
                },
                CRITICAL_ISSUES: {
                    target: 'failed',
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

        failed: {
            description: 'Deployment failed, manual intervention required',
            entry: 'alertOperationsTeam',
            on: {
                MANUAL_INTERVENTION_COMPLETE: {
                    target: 'idle',
                    actions: 'resetState'
                }
            }
        }
    }
});
