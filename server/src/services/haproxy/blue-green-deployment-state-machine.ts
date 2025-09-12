import { assign, setup } from 'xstate';
import { DeployGreenApplicationContainers } from './actions/deploy-green-application-containers';
import { MonitorGreenContainerStartup } from './actions/monitor-green-container-startup';
import { InitializeGreenLB } from './actions/initialize-green-lb';
import { PerformGreenHealthChecks } from './actions/perform-green-health-checks';
import { OpenTrafficToGreen } from './actions/open-traffic-to-green';
import { ValidateGreenTraffic } from './actions/validate-green-traffic';
import { InitiateBlueDrain } from './actions/initiate-blue-drain';
import { RemoveBlueFromLB } from './actions/remove-blue-from-lb';
import { StopBlueApplication } from './actions/stop-blue-application';
import { RemoveBlueApplication } from './actions/remove-blue-application';
import { RestoreBlueTraffic } from './actions/restore-blue-traffic';
import { DisableGreenTraffic } from './actions/disable-green-traffic';
import { RemoveGreenHAProxyConfig } from './actions/remove-green-haproxy-config';
import { StopGreenApplication } from './actions/stop-green-application';
import { RemoveGreenApplication } from './actions/remove-green-application';
import { LogDeploymentSuccess } from './actions/log-deployment-success';
import { AlertOperationsTeam } from './actions/alert-operations-team';
import { CleanupTempResources } from './actions/cleanup-temp-resources';

// Create instances of action classes
const deployGreenApplicationContainers = new DeployGreenApplicationContainers();
const monitorGreenContainerStartup = new MonitorGreenContainerStartup();
const initializeGreenLB = new InitializeGreenLB();
const performGreenHealthChecks = new PerformGreenHealthChecks();
const openTrafficToGreen = new OpenTrafficToGreen();
const validateGreenTraffic = new ValidateGreenTraffic();
const initiateBlueDrain = new InitiateBlueDrain();
const removeBlueFromLB = new RemoveBlueFromLB();
const stopBlueApplication = new StopBlueApplication();
const removeBlueApplication = new RemoveBlueApplication();
const restoreBlueTraffic = new RestoreBlueTraffic();
const disableGreenTraffic = new DisableGreenTraffic();
const removeGreenHAProxyConfig = new RemoveGreenHAProxyConfig();
const stopGreenApplication = new StopGreenApplication();
const removeGreenApplication = new RemoveGreenApplication();
const logDeploymentSuccess = new LogDeploymentSuccess();
const alertOperationsTeam = new AlertOperationsTeam();
const cleanupTempResources = new CleanupTempResources();

// Types for context and events
interface BlueGreenDeploymentContext {
    greenContainerId?: string;
    blueContainerId?: string;
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
}

type BlueGreenDeploymentEvent =
    // Deployment initiation
    | { type: 'START_DEPLOYMENT' }
    
    // Green deployment events
    | { type: 'DEPLOYMENT_SUCCESS'; containerId: string }
    | { type: 'DEPLOYMENT_ERROR'; error: string }
    | { type: 'CONTAINERS_RUNNING' }
    | { type: 'STARTUP_TIMEOUT' }
    
    // Load balancer configuration events
    | { type: 'LB_CONFIGURED' }
    | { type: 'LB_CONFIG_ERROR'; error: string }
    
    // Health check events
    | { type: 'SERVERS_HEALTHY' }
    | { type: 'HEALTH_CHECK_TIMEOUT' }
    
    // Traffic management events
    | { type: 'TRAFFIC_OPENED' }
    | { type: 'TRAFFIC_OPEN_FAILED'; error: string }
    | { type: 'TRAFFIC_VALIDATED' }
    | { type: 'VALIDATION_FAILED'; error: string }
    
    // Blue draining events
    | { type: 'DRAIN_INITIATED' }
    | { type: 'DRAIN_COMPLETE' }
    | { type: 'DRAIN_TIMEOUT' }
    | { type: 'DRAIN_ISSUES'; error: string }
    
    // Blue decommission events
    | { type: 'BLUE_LB_REMOVED' }
    | { type: 'BLUE_LB_REMOVAL_ERROR'; error: string }
    | { type: 'BLUE_APP_STOPPED' }
    | { type: 'BLUE_APP_STOP_ERROR'; error: string }
    | { type: 'BLUE_APP_REMOVED' }
    | { type: 'BLUE_APP_REMOVAL_ERROR'; error: string }
    
    // Rollback events
    | { type: 'ROLLBACK_BLUE_TRAFFIC_RESTORED' }
    | { type: 'ROLLBACK_GREEN_TRAFFIC_DISABLED' }
    | { type: 'ROLLBACK_GREEN_CONFIG_REMOVED' }
    | { type: 'ROLLBACK_GREEN_APP_STOPPED' }
    | { type: 'ROLLBACK_GREEN_APP_REMOVED' }
    | { type: 'ROLLBACK_COMPLETE' }
    | { type: 'ROLLBACK_ERROR'; error: string }
    
    // Completion events
    | { type: 'DEPLOYMENT_COMPLETE' }
    | { type: 'RESET' }
    | { type: 'MANUAL_INTERVENTION_COMPLETE' };

// The Blue-Green Update Deployment State Machine using setup
export const blueGreenDeploymentMachine = setup({
    types: {
        context: {} as BlueGreenDeploymentContext,
        events: {} as BlueGreenDeploymentEvent
    },
    actions: {
        // Green deployment actions
        deployGreenApplicationContainers: () => {
            deployGreenApplicationContainers.execute();
        },
        
        monitorGreenContainerStartup: () => {
            monitorGreenContainerStartup.execute();
        },

        // Load balancer configuration actions
        initializeGreenLB: () => {
            initializeGreenLB.execute();
        },

        performGreenHealthChecks: () => {
            performGreenHealthChecks.execute();
        },

        // Traffic management actions
        openTrafficToGreen: () => {
            openTrafficToGreen.execute();
        },

        validateGreenTraffic: () => {
            validateGreenTraffic.execute();
        },

        // Blue draining actions
        initiateBlueDrain: () => {
            initiateBlueDrain.execute();
        },

        monitorBlueDrain: assign({
            drainStartTime: () => Date.now()
        }),

        // Blue decommission actions
        removeBlueFromLB: () => {
            removeBlueFromLB.execute();
        },

        stopBlueApplication: () => {
            stopBlueApplication.execute();
        },

        removeBlueApplication: () => {
            removeBlueApplication.execute();
        },

        // Rollback actions
        restoreBlueTraffic: () => {
            restoreBlueTraffic.execute();
        },

        disableGreenTraffic: () => {
            disableGreenTraffic.execute();
        },

        removeGreenHAProxyConfig: () => {
            removeGreenHAProxyConfig.execute();
        },

        stopGreenApplication: () => {
            stopGreenApplication.execute();
        },

        removeGreenApplication: () => {
            removeGreenApplication.execute();
        },

        // Monitoring and completion actions
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
            greenContainerId: undefined,
            blueContainerId: undefined,
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
            activeConnections: 0
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
    id: 'blueGreenDeployment',
    initial: 'idle',
    context: {
        blueHealthy: false,
        greenHealthy: false,
        greenBackendConfigured: false,
        trafficOpenedToGreen: false,
        trafficValidated: false,
        blueDraining: false,
        blueDrained: false,
        validationErrors: 0,
        retryCount: 0,
        activeConnections: 0
    },

    states: {
        idle: {
            description: 'System is ready for deployment, no active deployment in progress',
            on: {
                START_DEPLOYMENT: {
                    target: 'deployingGreenApp',
                    actions: 'resetState'
                }
            }
        },

        deployingGreenApp: {
            description: 'Deploying green application containers',
            entry: 'deployGreenApplicationContainers',
            on: {
                DEPLOYMENT_SUCCESS: {
                    target: 'waitingGreenReady',
                    actions: assign({
                        greenContainerId: ({ event }) => {
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

        waitingGreenReady: {
            description: 'Waiting for green application containers to be ready',
            entry: 'monitorGreenContainerStartup',
            on: {
                CONTAINERS_RUNNING: {
                    target: 'initializingGreenLB',
                    actions: assign({ greenHealthy: true })
                },
                STARTUP_TIMEOUT: {
                    target: 'rollbackRemovingGreenApp',
                    actions: assign({ error: 'Green container startup timeout' })
                }
            },
            after: {
                120000: { // 2 minute timeout
                    target: 'rollbackRemovingGreenApp',
                    actions: assign({ error: 'Green application startup timeout' })
                }
            }
        },

        initializingGreenLB: {
            description: 'Preparing HAProxy configuration for green backend and registering servers',
            entry: 'initializeGreenLB',
            on: {
                LB_CONFIGURED: {
                    target: 'healthCheckWait',
                    actions: assign({ greenBackendConfigured: true })
                },
                LB_CONFIG_ERROR: {
                    target: 'rollbackStoppingGreenApp',
                    actions: 'preserveErrorContext'
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
                TRAFFIC_OPENED: {
                    target: 'validatingTraffic',
                    actions: assign({ trafficOpenedToGreen: true })
                },
                TRAFFIC_OPEN_FAILED: {
                    target: 'rollbackDisableGreenTraffic',
                    actions: 'preserveErrorContext'
                }
            }
        },

        validatingTraffic: {
            description: 'Monitoring green environment with live traffic',
            entry: 'validateGreenTraffic',
            on: {
                TRAFFIC_VALIDATED: {
                    target: 'drainingBlue',
                    actions: assign({ trafficValidated: true })
                },
                VALIDATION_FAILED: {
                    target: 'rollbackRestoreBlueTraffic',
                    actions: 'preserveErrorContext'
                }
            },
            after: {
                30000: { // 30 second minimum validation
                    target: 'drainingBlue',
                    guard: 'trafficValidationPassed'
                },
                60000: { // 60 second maximum validation
                    target: 'rollbackRestoreBlueTraffic',
                    actions: assign({ error: 'Traffic validation timeout' })
                }
            }
        },

        drainingBlue: {
            description: 'Initiating connection drain from blue environment',
            entry: ['initiateBlueDrain', 'monitorBlueDrain'],
            on: {
                DRAIN_INITIATED: {
                    target: 'waitingForDrain',
                    actions: assign({ blueDraining: true })
                }
            }
        },

        waitingForDrain: {
            description: 'Waiting for all blue connections to close',
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
                BLUE_LB_REMOVED: {
                    target: 'stoppingBlueApp'
                },
                BLUE_LB_REMOVAL_ERROR: {
                    target: 'failed',
                    actions: assign({ error: 'Unable to remove blue backend (Non-Critical)' })
                }
            }
        },

        stoppingBlueApp: {
            description: 'Stopping blue application containers',
            entry: 'stopBlueApplication',
            on: {
                BLUE_APP_STOPPED: {
                    target: 'removingBlueApp'
                },
                BLUE_APP_STOP_ERROR: {
                    target: 'failed',
                    actions: assign({ error: 'Blue app stop failed (Non-Critical)' })
                }
            }
        },

        removingBlueApp: {
            description: 'Removing blue application resources',
            entry: 'removeBlueApplication',
            on: {
                BLUE_APP_REMOVED: {
                    target: 'completed'
                },
                BLUE_APP_REMOVAL_ERROR: {
                    target: 'failed',
                    actions: assign({ error: 'Blue app removal failed (Non-Critical)' })
                }
            }
        },

        // Rollback states
        rollbackRestoreBlueTraffic: {
            description: 'Restoring traffic to the blue application during rollback',
            entry: 'restoreBlueTraffic',
            on: {
                ROLLBACK_BLUE_TRAFFIC_RESTORED: {
                    target: 'rollbackDisableGreenTraffic'
                },
                ROLLBACK_ERROR: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            }
        },

        rollbackDisableGreenTraffic: {
            description: 'Disabling traffic to green environment during rollback',
            entry: 'disableGreenTraffic',
            on: {
                ROLLBACK_GREEN_TRAFFIC_DISABLED: {
                    target: 'rollbackStoppingGreenApp'
                },
                ROLLBACK_ERROR: {
                    target: 'failed',
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
                    target: 'failed',
                    actions: assign({ error: 'Green app stop failed (Continue)' })
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
                    target: 'failed',
                    actions: assign({ error: 'Green app removal failed (Continue)' })
                }
            }
        },

        rollbackComplete: {
            description: 'Rollback successfully completed',
            entry: ['logDeploymentSuccess', 'cleanupTempResources'],
            on: {
                RESET: {
                    target: 'idle',
                    actions: 'resetState'
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

const blueGreenDeploymentActor = createActor(blueGreenDeploymentMachine);

// Subscribe to state changes
blueGreenDeploymentActor.subscribe((state) => {
    console.log(`Current state: ${state.value}`);
    console.log('Context:', state.context);
});

// Start the actor
blueGreenDeploymentActor.start();

// Example deployment flow simulation
export function simulateBlueGreenDeployment() {
    // Trigger deployment
    blueGreenDeploymentActor.send({ type: 'START_DEPLOYMENT' });

    // Simulate successful green container deployment
    setTimeout(() => {
        blueGreenDeploymentActor.send({
            type: 'DEPLOYMENT_SUCCESS',
            containerId: 'green-container-123'
        });
    }, 1000);

    // Simulate containers becoming ready
    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'CONTAINERS_RUNNING' });
    }, 3000);

    // Simulate load balancer configuration success
    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'LB_CONFIGURED' });
    }, 5000);

    // Simulate health checks passing
    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'SERVERS_HEALTHY' });
    }, 7000);

    // Simulate traffic opening successfully
    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'TRAFFIC_OPENED' });
    }, 9000);

    // Simulate traffic validation passing
    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'TRAFFIC_VALIDATED' });
    }, 12000);

    // Continue with drain simulation...
    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'DRAIN_INITIATED' });
    }, 15000);

    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'DRAIN_COMPLETE' });
    }, 18000);

    // Complete the flow...
    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'BLUE_LB_REMOVED' });
    }, 20000);

    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'BLUE_APP_STOPPED' });
    }, 22000);

    setTimeout(() => {
        blueGreenDeploymentActor.send({ type: 'BLUE_APP_REMOVED' });
    }, 24000);
}