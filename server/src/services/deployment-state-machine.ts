import { createMachine, assign } from "xstate";
import { deploymentLogger } from "../lib/logger-factory";
import {
  DeploymentConfig,
  DeploymentStep,
  DeploymentTriggerType,
  DeploymentStepStatus,
} from "@mini-infra/types";

// ====================
// Deployment Context Types
// ====================

export interface DeploymentContext {
  deploymentId: string;
  configurationId: string;
  config: DeploymentConfig;
  triggerType: DeploymentTriggerType;
  triggeredBy: string | null;
  dockerImage: string;

  // Container tracking
  oldContainerId: string | null;
  newContainerId: string | null;
  targetColor: "blue" | "green";

  // Progress tracking
  currentStep: string;
  steps: DeploymentStep[];
  startTime: number;

  // Health check results
  healthCheckPassed: boolean;
  healthCheckLogs: any[];

  // Error handling
  errorMessage: string | null;
  errorDetails: any;
  retryCount: number;
  maxRetries: number;

  // Metrics
  deploymentTime: number | null;
  downtime: number;
}

// ====================
// Deployment Events
// ====================

export type DeploymentEvent =
  | { type: "START_DEPLOYMENT" }
  | { type: "IMAGE_PULLED" }
  | { type: "IMAGE_PULL_FAILED"; error: string }
  | { type: "CONTAINER_CREATED"; containerId: string }
  | { type: "CONTAINER_CREATION_FAILED"; error: string }
  | { type: "CONTAINER_STARTED" }
  | { type: "CONTAINER_START_FAILED"; error: string }
  | { type: "HEALTH_CHECK_PASSED" }
  | { type: "HEALTH_CHECK_FAILED"; error: string }
  | { type: "TRAFFIC_SWITCHED" }
  | { type: "TRAFFIC_SWITCH_FAILED"; error: string }
  | { type: "CLEANUP_COMPLETED" }
  | { type: "CLEANUP_FAILED"; error: string }
  | { type: "RETRY" }
  | { type: "FORCE_ROLLBACK" }
  | { type: "ROLLBACK_COMPLETED" }
  | { type: "ROLLBACK_FAILED"; error: string };

// ====================
// State Machine Configuration
// ====================

export const deploymentStateMachine = createMachine(
  {
    types: {} as {
      context: DeploymentContext;
      events: DeploymentEvent;
      input: DeploymentContext;
    },
    id: "deployment",
    initial: "idle",
    context: ({ input }) => input || {
      deploymentId: "",
      configurationId: "",
      config: {} as DeploymentConfig,
      triggerType: "manual",
      triggeredBy: null,
      dockerImage: "",
      oldContainerId: null,
      newContainerId: null,
      targetColor: "blue",
      currentStep: "",
      steps: [],
      startTime: 0,
      healthCheckPassed: false,
      healthCheckLogs: [],
      errorMessage: null,
      errorDetails: null,
      retryCount: 0,
      maxRetries: 3,
      deploymentTime: null,
      downtime: 0,
    } as DeploymentContext,
    states: {
      idle: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "" }))],
        exit: ["logStateExit"],
        on: {
          START_DEPLOYMENT: {
            target: "preparing",
            actions: ["logDeploymentStart", "setStartTime", "logTransition"],
          },
        },
      },
      preparing: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "preparing" })), "logContextAfterAssign"],
        exit: ["logStateExit"],
        invoke: {
          src: "pullDockerImage",
          input: ({ context }) => context,
          onDone: {
            target: "deploying",
            actions: ["logImagePulled", "logTransition"],
          },
          onError: {
            target: "failed",
            actions: ["handleImagePullError", "logTransition"],
          },
        },
      },
      deploying: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "deploying" })), "logContextAfterAssign"],
        exit: ["logStateExit"],
        invoke: {
          src: "createAndStartContainer",
          input: ({ context }) => context,
          onDone: {
            target: "health_checking",
            actions: ["setNewContainerId", "logContainerCreated", "logTransition"],
          },
          onError: {
            target: "failed",
            actions: ["handleContainerError", "logTransition"],
          },
        },
      },
      health_checking: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "health_checking" })), "logContextAfterAssign"],
        exit: ["logStateExit"],
        invoke: {
          src: "performHealthChecks",
          input: ({ context }) => context,
          onDone: {
            target: "switching_traffic",
            actions: ["setHealthCheckPassed", "logHealthCheckPassed", "logTransition"],
          },
          onError: [
            {
              target: "failed",
              guard: "maxRetriesReached",
              actions: ["handleHealthCheckError", "logTransition"],
            },
            {
              target: "health_checking",
              actions: ["incrementRetryCount", "logHealthCheckRetry", "logTransition"],
            },
          ],
        },
      },
      switching_traffic: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "switching_traffic" })), "logContextAfterAssign"],
        exit: ["logStateExit"],
        invoke: {
          src: "switchTrafficToNewContainer",
          input: ({ context }) => context,
          onDone: {
            target: "cleanup",
            actions: ["logTrafficSwitched", "logTransition"],
          },
          onError: {
            target: "rolling_back",
            actions: ["handleTrafficSwitchError", "logTransition"],
          },
        },
      },
      cleanup: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "cleanup" })), "logContextAfterAssign"],
        exit: ["logStateExit"],
        invoke: {
          src: "cleanupOldContainer",
          input: ({ context }) => context,
          onDone: {
            target: "completed",
            actions: ["calculateDeploymentTime", "logDeploymentCompleted", "logTransition"],
          },
          onError: {
            target: "completed",
            actions: ["logCleanupError", "calculateDeploymentTime", "logTransition"],
          },
        },
      },
      completed: {
        type: "final",
        entry: ["logStateEntry", "finalizeDeployment", "logFinalState"],
      },
      failed: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "failed" })), "logFinalState"],
        on: {
          RETRY: {
            target: "preparing",
            guard: "canRetry",
            actions: ["resetForRetry", "logTransition"],
          },
          FORCE_ROLLBACK: {
            target: "rolling_back",
            actions: ["logTransition"],
          },
        },
      },
      rolling_back: {
        entry: ["logStateEntry", assign(() => ({ currentStep: "rolling_back" })), "logContextAfterAssign"],
        exit: ["logStateExit"],
        invoke: {
          src: "performRollback",
          input: ({ context }) => context,
          onDone: {
            target: "completed",
            actions: ["logRollbackCompleted", "calculateDeploymentTime", "logTransition"],
          },
          onError: {
            target: "failed",
            actions: ["handleRollbackError", "logTransition"],
          },
        },
      },
    },
  },
  {
    actions: {
      setNewContainerId: assign(({ context, event }) => {
        const containerId = (event as any).output?.containerId || null;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "setNewContainerId",
            previousContainerId: context.newContainerId,
            newContainerId: containerId,
            eventOutput: (event as any).output,
          },
          "Setting new container ID from event output"
        );
        return {
          newContainerId: containerId,
        };
      }),
      setHealthCheckPassed: assign(({ context }) => {
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "setHealthCheckPassed",
            previousValue: context.healthCheckPassed,
            newValue: true,
          },
          "Setting health check status to passed"
        );
        return {
          healthCheckPassed: true,
        };
      }),
      incrementRetryCount: assign(({ context }) => {
        const newRetryCount = context.retryCount + 1;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "incrementRetryCount",
            previousRetryCount: context.retryCount,
            newRetryCount,
            maxRetries: context.maxRetries,
            remaining: context.maxRetries - newRetryCount,
          },
          "Incrementing retry count after failure"
        );
        return {
          retryCount: newRetryCount,
        };
      }),
      resetForRetry: assign(({ context }) => {
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "resetForRetry",
            previousRetryCount: context.retryCount,
            previousErrorMessage: context.errorMessage,
            previousErrorDetails: context.errorDetails,
          },
          "Resetting deployment state for retry attempt"
        );
        return {
          retryCount: 0,
          errorMessage: null,
          errorDetails: null,
        };
      }),
      handleError: assign(({ context, event }) => {
        const errorMessage = (event as any).error || "Unknown error";
        const errorDetails = (event as any).data || null;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "handleError",
            errorMessage,
            errorDetails,
            eventType: (event as any).type,
            previousError: context.errorMessage,
          },
          "Handling general error in deployment"
        );
        return {
          errorMessage,
          errorDetails,
        };
      }),
      handleImagePullError: assign(({ context, event }) => {
        const error = (event as any).error;
        const errorMessage = `Failed to pull image: ${error}`;
        const errorDetails = (event as any).data;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "handleImagePullError",
            dockerImage: context.dockerImage,
            error,
            errorMessage,
            errorDetails,
          },
          "Handling Docker image pull failure"
        );
        return {
          errorMessage,
          errorDetails,
        };
      }),
      handleContainerError: assign(({ context, event }) => {
        const error = (event as any).error;
        const errorMessage = `Failed to create/start container: ${error}`;
        const errorDetails = (event as any).data;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "handleContainerError",
            targetColor: context.targetColor,
            dockerImage: context.dockerImage,
            error,
            errorMessage,
            errorDetails,
          },
          "Handling container creation/start failure"
        );
        return {
          errorMessage,
          errorDetails,
        };
      }),
      handleHealthCheckError: assign(({ context, event }) => {
        const error = (event as any).error;
        const errorMessage = `Health check failed: ${error}`;
        const errorDetails = (event as any).data;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "handleHealthCheckError",
            newContainerId: context.newContainerId,
            retryCount: context.retryCount,
            maxRetries: context.maxRetries,
            willRetry: context.retryCount < context.maxRetries,
            error,
            errorMessage,
            errorDetails,
          },
          "Handling health check failure"
        );
        return {
          errorMessage,
          errorDetails,
        };
      }),
      handleTrafficSwitchError: assign(({ context, event }) => {
        const error = (event as any).error;
        const errorMessage = `Failed to switch traffic: ${error}`;
        const errorDetails = (event as any).data;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "handleTrafficSwitchError",
            oldContainerId: context.oldContainerId,
            newContainerId: context.newContainerId,
            targetColor: context.targetColor,
            error,
            errorMessage,
            errorDetails,
          },
          "Handling traffic switch failure - will attempt rollback"
        );
        return {
          errorMessage,
          errorDetails,
        };
      }),
      handleRollbackError: assign(({ context, event }) => {
        const error = (event as any).error;
        const errorMessage = `Rollback failed: ${error}`;
        const errorDetails = (event as any).data;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "handleRollbackError",
            oldContainerId: context.oldContainerId,
            newContainerId: context.newContainerId,
            previousError: context.errorMessage,
            error,
            errorMessage,
            errorDetails,
          },
          "Handling rollback failure - deployment in critical state"
        );
        return {
          errorMessage,
          errorDetails,
        };
      }),
      calculateDeploymentTime: assign(({ context }) => {
        const deploymentTime = (Date.now() - context.startTime) / 1000;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            action: "calculateDeploymentTime",
            startTime: new Date(context.startTime).toISOString(),
            endTime: new Date().toISOString(),
            deploymentTimeSeconds: deploymentTime,
            downtime: context.downtime,
          },
          "Calculating final deployment metrics"
        );
        return {
          deploymentTime,
        };
      }),
      finalizeDeployment: () => {
        // This action is for side effects only, no context update needed
      },
      logDeploymentStart: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            applicationName: context.config.applicationName,
            dockerImage: context.dockerImage,
            triggerType: context.triggerType,
          },
          "Deployment started",
        );
      },
      setStartTime: assign(() => ({
        startTime: Date.now(),
      })),
      logImagePulled: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            dockerImage: context.dockerImage,
          },
          "Docker image pulled successfully",
        );
      },
      logContainerCreated: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            containerId: context.newContainerId,
          },
          "Container created and started successfully",
        );
      },
      logHealthCheckPassed: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            containerId: context.newContainerId,
          },
          "Health checks passed",
        );
      },
      logHealthCheckRetry: ({ context }) => {
        deploymentLogger().warn(
          {
            deploymentId: context.deploymentId,
            retryCount: context.retryCount,
            maxRetries: context.maxRetries,
          },
          "Health check failed, retrying",
        );
      },
      logTrafficSwitched: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            newContainerId: context.newContainerId,
            oldContainerId: context.oldContainerId,
          },
          "Traffic switched to new container",
        );
      },
      logCleanupError: ({ context, event }) => {
        deploymentLogger().warn(
          {
            deploymentId: context.deploymentId,
            oldContainerId: context.oldContainerId,
            error: (event as any).error,
          },
          "Cleanup failed but deployment considered successful",
        );
      },
      logDeploymentCompleted: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            applicationName: context.config.applicationName,
            deploymentTime: context.deploymentTime,
            downtime: context.downtime,
          },
          "Deployment completed successfully",
        );
      },
      logRollbackCompleted: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            applicationName: context.config.applicationName,
          },
          "Rollback completed successfully",
        );
      },
      logFinalState: ({ context }) => {
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            deploymentTime: context.deploymentTime,
            errorMessage: context.errorMessage,
          },
          "Deployment reached final state",
        );
      },
      
      // ====================
      // Debug Logging Actions
      // ====================
      
      logStateEntry: ({ context }) => {
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            event: "stateEntry",
            currentStep: context.currentStep,
            retryCount: context.retryCount,
            maxRetries: context.maxRetries,
            hasError: !!context.errorMessage,
            errorMessage: context.errorMessage,
            contextSnapshot: {
              oldContainerId: context.oldContainerId,
              newContainerId: context.newContainerId,
              targetColor: context.targetColor,
              healthCheckPassed: context.healthCheckPassed,
              deploymentTime: context.deploymentTime,
              downtime: context.downtime,
            },
          },
          `Entering state: ${context.currentStep}`
        );
      },
      
      logStateExit: ({ context }) => {
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            event: "stateExit",
            currentStep: context.currentStep,
            retryCount: context.retryCount,
            hasError: !!context.errorMessage,
            errorMessage: context.errorMessage,
          },
          `Exiting state: ${context.currentStep}`
        );
      },
      
      logTransition: ({ context, event }) => {
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            event: "stateTransition",
            fromState: context.currentStep,
            eventType: event?.type || "unknown",
            eventData: event && 'error' in event ? { error: event.error } : undefined,
            currentStep: context.currentStep,
            retryCount: context.retryCount,
            contextSnapshot: {
              oldContainerId: context.oldContainerId,
              newContainerId: context.newContainerId,
              targetColor: context.targetColor,
              healthCheckPassed: context.healthCheckPassed,
              hasError: !!context.errorMessage,
            },
          },
          `State transition triggered by ${event?.type || "unknown"} event`
        );
      },
      
      logContextAfterAssign: ({ context }) => {
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            event: "contextUpdated",
            stateName: context.currentStep,
            updatedContext: {
              currentStep: context.currentStep,
              retryCount: context.retryCount,
              maxRetries: context.maxRetries,
              oldContainerId: context.oldContainerId,
              newContainerId: context.newContainerId,
              targetColor: context.targetColor,
              healthCheckPassed: context.healthCheckPassed,
              errorMessage: context.errorMessage,
              deploymentTime: context.deploymentTime,
              downtime: context.downtime,
              startTime: context.startTime,
            },
          },
          `Context updated in state: ${context.currentStep}`
        );
      },
    },
    guards: {
      maxRetriesReached: ({ context }) => {
        const result = context.retryCount >= context.maxRetries;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            guard: "maxRetriesReached",
            retryCount: context.retryCount,
            maxRetries: context.maxRetries,
            guardResult: result,
            remainingRetries: context.maxRetries - context.retryCount,
          },
          `Guard evaluation: maxRetriesReached = ${result}`
        );
        return result;
      },
      canRetry: ({ context }) => {
        const result = context.retryCount < context.maxRetries;
        deploymentLogger().debug(
          {
            deploymentId: context.deploymentId,
            guard: "canRetry",
            retryCount: context.retryCount,
            maxRetries: context.maxRetries,
            guardResult: result,
            remainingRetries: context.maxRetries - context.retryCount,
          },
          `Guard evaluation: canRetry = ${result}`
        );
        return result;
      },
    },
  },
);