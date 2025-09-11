import { assign, setup } from 'xstate';

// Types for context and events
interface InitialDeploymentContext {
    containerId?: string;
    applicationReady: boolean;
    haproxyConfigured: boolean;
    healthChecksPassed: boolean;
    trafficEnabled: boolean;
    validationErrors: number;
    monitoringStartTime?: number;
    error?: string;
    retryCount: number;
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
        deployApplicationContainers: () => {
            console.log('Action: Deploying application containers...');
        },
        monitorContainerStartup: () => {
            console.log('Action: Monitoring container startup...');
        },
        initializeHAProxy: () => {
            console.log('Action: Initializing HAProxy and creating backend...');
        },
        performHealthChecks: () => {
            console.log('Action: Performing health checks on servers...');
        },
        enableTraffic: () => {
            console.log('Action: Enabling traffic to backend...');
        },
        validateTraffic: () => {
            console.log('Action: Validating traffic patterns...');
        },
        startExtendedMonitoring: assign({
            monitoringStartTime: () => Date.now()
        }),
        logDeploymentSuccess: () => {
            console.log('Action: Logging deployment success...');
        },
        alertOperationsTeam: () => {
            console.log('Action: Alerting operations team of failure...');
        },
        cleanupTempResources: () => {
            console.log('Action: Cleaning up temporary resources...');
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
        applicationReady: false,
        haproxyConfigured: false,
        healthChecksPassed: false,
        trafficEnabled: false,
        validationErrors: 0,
        retryCount: 0
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

// Example usage
import { createActor } from 'xstate';

const deploymentActor = createActor(initialDeploymentMachine);

// Subscribe to state changes
deploymentActor.subscribe((state) => {
    console.log(`Current state: ${state.value}`);
    console.log('Context:', state.context);
});

// Start the actor
deploymentActor.start();

// Trigger deployment
deploymentActor.send({ type: 'START_DEPLOYMENT' });

// Simulate successful container deployment
setTimeout(() => {
    deploymentActor.send({
        type: 'DEPLOYMENT_SUCCESS',
        containerId: 'container-123'
    });
}, 1000);

// Continue simulation...