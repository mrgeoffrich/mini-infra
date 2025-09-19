import { assign, setup } from 'xstate';
import { DeployApplicationContainers } from './actions/deploy-application-containers';
import { MonitorContainerStartup } from './actions/monitor-container-startup';
import { AddContainerToLB } from './actions/add-container-to-lb';
import { PerformHealthChecks } from './actions/perform-health-checks';
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
    applicationReady: boolean;
    haproxyConfigured: boolean;
    healthChecksPassed: boolean;
    trafficEnabled: boolean;
    validationErrors: number;
    monitoringStartTime?: number;
    error?: string;
    retryCount: number;

    // Deployment metadata
    triggerType: string;
    triggeredBy?: string;
    startTime: number;
}

type InitialDeploymentEvent =
    | { type: 'START_DEPLOYMENT' }
    | { type: 'DEPLOYMENT_SUCCESS'; containerId: string }
    | { type: 'DEPLOYMENT_ERROR'; error: string }
    | { type: 'CONTAINERS_RUNNING' }
    | { type: 'STARTUP_TIMEOUT' }
    | { type: 'LB_CONFIGURED' }
    | { type: 'LB_CONFIG_ERROR'; error: string }
    | { type: 'SERVERS_HEALTHY' }
    | { type: 'HEALTH_CHECK_TIMEOUT' }
    | { type: 'TRAFFIC_ENABLED' }
    | { type: 'TRAFFIC_ENABLE_FAILED'; error: string }
    | { type: 'TRAFFIC_STABLE' }
    | { type: 'CRITICAL_ISSUES'; error: string }
    | { type: 'MONITORING_COMPLETE' }
    | { type: 'ISSUES_DETECTED'; error: string }
    | { type: 'RESET' }
    | { type: 'MANUAL_INTERVENTION_COMPLETE' };

// The Initial Deployment State Machine using setup
export const initialDeploymentMachine = setup({
    types: {
        context: {} as InitialDeploymentContext,
        events: {} as InitialDeploymentEvent
    },
    actions: {
        deployApplicationContainers: ({ context }) => {
            deployApplicationContainers.execute(context);
        },
        monitorContainerStartup: ({ context }) => {
            monitorContainerStartup.execute(context);
        },
        initializeHAProxy: ({ context }) => {
            addContainerToLB.execute(context);
        },
        performHealthChecks: ({ context }) => {
            performHealthChecks.execute(context);
        },
        enableTraffic: ({ context }) => {
            enableTraffic.execute(context);
        },
        validateTraffic: () => {
            validateTraffic.execute();
        },
        startExtendedMonitoring: assign({
            monitoringStartTime: () => Date.now()
        }),
        logDeploymentSuccess: () => {
            logDeploymentSuccess.execute();
        },
        alertOperationsTeam: () => {
            alertOperationsTeam.execute();
        },
        cleanupTempResources: () => {
            cleanupTempResources.execute();
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
            applicationReady: false,
            haproxyConfigured: false,
            healthChecksPassed: false,
            trafficEnabled: false,
            validationErrors: 0,
            monitoringStartTime: undefined,
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
        monitoringPeriodComplete: ({ context }) => {
            if (!context.monitoringStartTime) return false;
            const elapsed = Date.now() - context.monitoringStartTime;
            return elapsed >= 300000; // 5 minutes
        }
    }
}).createMachine({
    id: 'initialDeployment',
    initial: 'idle',
    context: {
        // Deployment identifiers
        deploymentId: "",
        configurationId: "",
        applicationName: "",
        dockerImage: "",

        // Environment context
        environmentId: "",
        environmentName: "",
        haproxyContainerId: "",
        haproxyNetworkName: "",

        // Container state
        applicationReady: false,
        haproxyConfigured: false,
        healthChecksPassed: false,
        trafficEnabled: false,
        validationErrors: 0,
        retryCount: 0,

        // Deployment metadata
        triggerType: "manual",
        triggeredBy: undefined,
        startTime: Date.now(),
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
                    actions: assign({ applicationReady: true })
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
                    target: 'enablingTraffic',
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
                    target: 'initialMonitoring'
                },
                CRITICAL_ISSUES: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            },
            after: {
                30000: { // 30 second minimum validation
                    target: 'initialMonitoring',
                    guard: 'trafficStable'
                }
            }
        },

        initialMonitoring: {
            description: 'Extended monitoring for first deployment',
            entry: 'startExtendedMonitoring',
            on: {
                MONITORING_COMPLETE: {
                    target: 'completed'
                },
                ISSUES_DETECTED: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            },
            after: {
                300000: { // 5 minute monitoring period
                    target: 'completed'
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
