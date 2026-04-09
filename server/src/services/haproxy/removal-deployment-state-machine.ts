import { assign, setup } from 'xstate';
import { RemoveContainerFromLB} from './actions/remove-container-from-lb';
import { RemoveFrontend } from './actions/remove-frontend';
import { StopApplication } from './actions/stop-application';
import { RemoveApplication } from './actions/remove-application';
import { LogDeploymentSuccess } from './actions/log-deployment-success';
import { AlertOperationsTeam } from './actions/alert-operations-team';
import { CleanupTempResources } from './actions/cleanup-temp-resources';

// Create instances of action classes
const removeContainerFromLB = new RemoveContainerFromLB();
const removeFrontend = new RemoveFrontend();
const stopApplication = new StopApplication();
const removeApplication = new RemoveApplication();
const logDeploymentSuccess = new LogDeploymentSuccess();
const alertOperationsTeam = new AlertOperationsTeam();
const cleanupTempResources = new CleanupTempResources();

// Types for context and events
interface RemovalDeploymentContext {
    // Deployment identifiers
    deploymentId: string;
    configurationId: string;
    applicationName: string;

    // Environment context
    environmentId: string;
    environmentName: string;
    haproxyContainerId: string;
    haproxyNetworkName: string;

    // Container state
    containerId?: string;
    containersToRemove: string[];
    lbRemovalComplete: boolean;
    frontendRemoved: boolean;
    applicationStopped: boolean;
    applicationRemoved: boolean;
    error?: string;
    retryCount: number;

    // Deployment metadata
    triggerType: string;
    triggeredBy?: string;
    startTime: number;

    // Configuration
    config?: Record<string, any>;
}

type RemovalDeploymentEvent =
    | { type: 'START_REMOVAL' }
    | { type: 'LB_REMOVAL_SUCCESS' }
    | { type: 'LB_REMOVAL_FAILED'; error: string }
    | { type: 'FRONTEND_REMOVED'; frontendName?: string }
    | { type: 'FRONTEND_REMOVAL_SKIPPED'; message?: string }
    | { type: 'FRONTEND_REMOVAL_ERROR'; error: string }
    | { type: 'STOP_SUCCESS'; stoppedContainers?: string[] }
    | { type: 'STOP_FAILED'; error: string }
    | { type: 'REMOVAL_SUCCESS'; removedContainers?: string[] }
    | { type: 'REMOVAL_FAILED'; error: string }
    | { type: 'CLEANUP_SUCCESS' }
    | { type: 'CLEANUP_FAILED'; error: string }
    | { type: 'RESET' }
    | { type: 'MANUAL_INTERVENTION_COMPLETE' };

// The Removal Deployment State Machine using setup
export const removalDeploymentMachine = setup({
    types: {
        context: {} as RemovalDeploymentContext,
        events: {} as RemovalDeploymentEvent
    },
    actions: {
        removeContainerFromLB: ({ context, self }) => {
            // Execute async action with event callback
            const result = removeContainerFromLB.execute(context, (event) => {
                self.send(event);
            });

            // Handle promise rejection if execute returns a promise
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    self.send({
                        type: 'LB_REMOVAL_FAILED',
                        error: error.message || 'Unknown error'
                    });
                });
            }
        },
        removeFrontend: ({ context, self }) => {
            // Execute async action with event callback
            const result = removeFrontend.execute(context, (event) => {
                self.send(event);
            });

            // Handle promise rejection if execute returns a promise
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    self.send({
                        type: 'FRONTEND_REMOVAL_ERROR',
                        error: error.message || 'Unknown error'
                    });
                });
            }
        },
        stopApplication: ({ context, self }) => {
            // Execute async action with event callback
            const result = stopApplication.execute(context, (event) => {
                self.send(event);
            });

            // Handle promise rejection if execute returns a promise
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    self.send({
                        type: 'STOP_FAILED',
                        error: error.message || 'Unknown error'
                    });
                });
            }
        },
        removeApplication: ({ context, self }) => {
            // Execute async action with event callback
            const result = removeApplication.execute(context, (event) => {
                self.send(event);
            });

            // Handle promise rejection if execute returns a promise
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    self.send({
                        type: 'REMOVAL_FAILED',
                        error: error.message || 'Unknown error'
                    });
                });
            }
        },
        logDeploymentSuccess: ({ context }) => {
            logDeploymentSuccess.execute(context);
        },
        alertOperationsTeam: ({ context }) => {
            alertOperationsTeam.execute(context);
        },
        cleanupTempResources: ({ context }) => {
            // Just execute cleanup - the state will automatically transition
            // CleanupTempResources.execute() never throws, it handles all errors internally
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
        updateStoppedContainers: assign({
            containersToRemove: ({ context, event }) => {
                if (event.type === 'STOP_SUCCESS' && event.stoppedContainers) {
                    return [...context.containersToRemove, ...event.stoppedContainers];
                }
                return context.containersToRemove;
            }
        }),
        resetState: assign({
            // Keep deployment identifiers, environment context, and containersToRemove (input data)
            // Only reset removal progress state
            containerId: () => undefined,
            lbRemovalComplete: () => false,
            frontendRemoved: () => false,
            applicationStopped: () => false,
            applicationRemoved: () => false,
            error: () => undefined,
            retryCount: () => 0
        })
    },
    guards: {
        lbRemovalCompleted: ({ context }) => {
            return context.lbRemovalComplete;
        },
        applicationStopped: ({ context }) => {
            return context.applicationStopped;
        },
        applicationRemoved: ({ context }) => {
            return context.applicationRemoved;
        }
    }
}).createMachine({
    id: 'removalDeployment',
    initial: 'idle',
    context: ({ input }) => {
        const removalInput = input as RemovalDeploymentContext | undefined;
        return {
            // Use input values if provided, otherwise use defaults
            deploymentId: removalInput?.deploymentId || "",
            configurationId: removalInput?.configurationId || "",
            applicationName: removalInput?.applicationName || "",

            // Environment context
            environmentId: removalInput?.environmentId || "",
            environmentName: removalInput?.environmentName || "",
            haproxyContainerId: removalInput?.haproxyContainerId || "",
            haproxyNetworkName: removalInput?.haproxyNetworkName || "",

            // Container state
            containerId: removalInput?.containerId,
            containersToRemove: removalInput?.containersToRemove || [],
            lbRemovalComplete: removalInput?.lbRemovalComplete || false,
            frontendRemoved: removalInput?.frontendRemoved || false,
            applicationStopped: removalInput?.applicationStopped || false,
            applicationRemoved: removalInput?.applicationRemoved || false,
            error: removalInput?.error,
            retryCount: removalInput?.retryCount || 0,

            // Deployment metadata
            triggerType: removalInput?.triggerType || "manual",
            triggeredBy: removalInput?.triggeredBy,
            startTime: removalInput?.startTime || Date.now(),

            // Configuration
            config: removalInput?.config,
        };
    },

    states: {
        idle: {
            description: 'System is ready for removal, no active removal in progress',
            on: {
                START_REMOVAL: {
                    target: 'removingFromLB',
                    actions: 'resetState'
                }
            }
        },

        removingFromLB: {
            description: 'Removing container from HAProxy load balancer',
            entry: 'removeContainerFromLB',
            on: {
                LB_REMOVAL_SUCCESS: {
                    target: 'removingFrontend',
                    actions: assign({ lbRemovalComplete: true })
                },
                LB_REMOVAL_FAILED: {
                    // Don't fail entire removal for LB errors - continue cleanup
                    target: 'removingFrontend',
                    actions: assign({
                        lbRemovalComplete: false,
                        error: ({ event }) => {
                            if ('error' in event) {
                                return `LB removal warning: ${event.error}`;
                            }
                            return 'LB removal failed (non-critical)';
                        }
                    })
                }
            },
            after: {
                60000: { // 1 minute timeout for LB removal
                    target: 'removingFrontend',
                    actions: assign({
                        lbRemovalComplete: false,
                        error: 'LB removal timeout (non-critical)'
                    })
                }
            }
        },

        removingFrontend: {
            description: 'Removing HAProxy frontend configuration',
            entry: 'removeFrontend',
            on: {
                FRONTEND_REMOVED: {
                    target: 'stoppingApplication',
                    actions: assign({ frontendRemoved: true })
                },
                FRONTEND_REMOVAL_SKIPPED: {
                    target: 'stoppingApplication',
                    actions: assign({ frontendRemoved: false })
                },
                FRONTEND_REMOVAL_ERROR: {
                    // Don't fail entire removal for frontend errors
                    target: 'stoppingApplication',
                    actions: assign({
                        frontendRemoved: false,
                        error: ({ event }) => {
                            if ('error' in event) {
                                return `Frontend removal warning: ${event.error}`;
                            }
                            return 'Frontend removal failed (non-critical)';
                        }
                    })
                }
            },
            after: {
                60000: { // 1 minute timeout for frontend removal
                    target: 'stoppingApplication',
                    actions: assign({
                        frontendRemoved: false,
                        error: 'Frontend removal timeout (non-critical)'
                    })
                }
            }
        },

        stoppingApplication: {
            description: 'Stopping application containers gracefully',
            entry: 'stopApplication',
            on: {
                STOP_SUCCESS: {
                    target: 'removingApplication',
                    actions: [
                        assign({ applicationStopped: true }),
                        'updateStoppedContainers'
                    ]
                },
                STOP_FAILED: {
                    // Don't fail entire removal for stop errors - continue cleanup
                    target: 'removingApplication',
                    actions: assign({
                        applicationStopped: false,
                        error: ({ event }) => {
                            if ('error' in event) {
                                return `Application stop warning: ${event.error}`;
                            }
                            return 'Application stop failed (non-critical)';
                        }
                    })
                }
            },
            after: {
                90000: { // 90 second timeout for stopping containers
                    target: 'removingApplication',
                    actions: assign({
                        applicationStopped: false,
                        error: 'Application stop timeout (non-critical)'
                    })
                }
            }
        },

        removingApplication: {
            description: 'Removing application containers and cleaning up resources',
            entry: 'removeApplication',
            on: {
                REMOVAL_SUCCESS: {
                    target: 'cleanup',
                    actions: assign({ applicationRemoved: true })
                },
                REMOVAL_FAILED: {
                    // Don't fail entire removal for container removal errors - continue cleanup
                    target: 'cleanup',
                    actions: assign({
                        applicationRemoved: false,
                        error: ({ event }) => {
                            if ('error' in event) {
                                return `Application removal warning: ${event.error}`;
                            }
                            return 'Application removal failed (non-critical)';
                        }
                    })
                }
            },
            after: {
                120000: { // 2 minute timeout for container removal
                    target: 'cleanup',
                    actions: assign({
                        applicationRemoved: false,
                        error: 'Application removal timeout (non-critical)'
                    })
                }
            }
        },

        cleanup: {
            description: 'Cleaning up temporary resources',
            entry: 'cleanupTempResources',
            // Automatically transition to completed after cleanup runs
            // The cleanup action never throws errors, it handles them internally
            always: {
                target: 'completed'
            }
        },

        completed: {
            type: 'final' as const,
            description: 'Deployment removal successfully completed',
            entry: 'logDeploymentSuccess',
            on: {
                RESET: {
                    target: 'idle',
                    actions: 'resetState'
                }
            }
        },

        failed: {
            description: 'Deployment removal failed, manual intervention required',
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