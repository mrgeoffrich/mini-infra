import { assign, setup } from 'xstate';
import { DeploymentConfig } from '@mini-infra/types';
import { RemoveContainerFromLB } from './actions/remove-container-from-lb';
import { StopApplication } from './actions/stop-application';
import { RemoveApplication } from './actions/remove-application';
import { LogDeploymentSuccess } from './actions/log-deployment-success';
import { AlertOperationsTeam } from './actions/alert-operations-team';
import { CleanupTempResources } from './actions/cleanup-temp-resources';

// Create instances of action classes
const removeContainerFromLB = new RemoveContainerFromLB();
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
    applicationStopped: boolean;
    applicationRemoved: boolean;
    error?: string;
    retryCount: number;

    // Deployment metadata
    triggerType: string;
    triggeredBy?: string;
    startTime: number;

    // Configuration
    config?: DeploymentConfig;
}

type RemovalDeploymentEvent =
    | { type: 'START_REMOVAL' }
    | { type: 'LB_REMOVAL_SUCCESS' }
    | { type: 'LB_REMOVAL_FAILED'; error: string }
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
        cleanupTempResources: ({ context, self }) => {
            try {
                cleanupTempResources.execute(context);
                self.send({ type: 'CLEANUP_SUCCESS' });
            } catch (error) {
                self.send({
                    type: 'CLEANUP_FAILED',
                    error: error instanceof Error ? error.message : 'Unknown cleanup error'
                });
            }
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
            // Keep deployment identifiers and environment context
            // Only reset removal state
            containerId: () => undefined,
            containersToRemove: () => [],
            lbRemovalComplete: () => false,
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
                    target: 'stoppingApplication',
                    actions: assign({ lbRemovalComplete: true })
                },
                LB_REMOVAL_FAILED: {
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            },
            after: {
                60000: { // 1 minute timeout for LB removal
                    target: 'failed',
                    actions: assign({ error: 'Load balancer removal timeout' })
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
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            },
            after: {
                90000: { // 90 second timeout for stopping containers
                    target: 'failed',
                    actions: assign({ error: 'Container stop timeout' })
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
                    target: 'failed',
                    actions: 'preserveErrorContext'
                }
            },
            after: {
                120000: { // 2 minute timeout for container removal
                    target: 'failed',
                    actions: assign({ error: 'Container removal timeout' })
                }
            }
        },

        cleanup: {
            description: 'Cleaning up temporary resources',
            entry: 'cleanupTempResources',
            on: {
                CLEANUP_SUCCESS: {
                    target: 'completed'
                },
                CLEANUP_FAILED: {
                    // Don't fail the entire process for cleanup failures
                    target: 'completed',
                    actions: assign({ error: ({ event }) => {
                        if ('error' in event) {
                            return `Cleanup warning: ${event.error}`;
                        }
                        return 'Cleanup completed with warnings';
                    }})
                }
            },
            after: {
                30000: { // 30 second timeout for cleanup
                    target: 'completed',
                    actions: assign({ error: 'Cleanup timeout (non-critical)' })
                }
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