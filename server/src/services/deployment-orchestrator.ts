import { createMachine, createActor, assign, fromPromise } from "xstate";
import { deploymentLogger } from "../lib/logger-factory";
import { ContainerLifecycleManager } from "./container-lifecycle-manager";
import { TraefikIntegrationService } from "./traefik-integration";
import { HealthCheckService } from "./health-check";
import {
  DeploymentConfig,
  DeploymentStatus,
  DeploymentTriggerType,
  DeploymentStep,
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

const deploymentStateMachine = createMachine({
  types: {} as {
    context: DeploymentContext;
    events: DeploymentEvent;
  },
  id: "deployment",
  initial: "idle",
  context: {
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
      on: {
        START_DEPLOYMENT: {
          target: "preparing",
          actions: ["initializeDeployment", "logDeploymentStart"],
        },
      },
    },
    preparing: {
      entry: ["setCurrentStep"],
      invoke: {
        src: "pullDockerImage",
        onDone: {
          target: "deploying",
          actions: ["logImagePulled"],
        },
        onError: {
          target: "failed",
          actions: ["handleImagePullError"],
        },
      },
    },
    deploying: {
      entry: ["setCurrentStep"],
      invoke: {
        src: "createAndStartContainer",
        onDone: {
          target: "health_checking",
          actions: ["setNewContainerId", "logContainerCreated"],
        },
        onError: {
          target: "failed",
          actions: ["handleContainerError"],
        },
      },
    },
    health_checking: {
      entry: ["setCurrentStep"],
      invoke: {
        src: "performHealthChecks",
        onDone: {
          target: "switching_traffic",
          actions: ["setHealthCheckPassed", "logHealthCheckPassed"],
        },
        onError: [
          {
            target: "failed",
            guard: "maxRetriesReached",
            actions: ["handleHealthCheckError"],
          },
          {
            target: "health_checking",
            actions: ["incrementRetryCount", "logHealthCheckRetry"],
          },
        ],
      },
    },
    switching_traffic: {
      entry: ["setCurrentStep"],
      invoke: {
        src: "switchTrafficToNewContainer",
        onDone: {
          target: "cleanup",
          actions: ["logTrafficSwitched"],
        },
        onError: {
          target: "rolling_back",
          actions: ["handleTrafficSwitchError"],
        },
      },
    },
    cleanup: {
      entry: ["setCurrentStep"],
      invoke: {
        src: "cleanupOldContainer",
        onDone: {
          target: "completed",
          actions: ["calculateDeploymentTime", "logDeploymentCompleted"],
        },
        onError: {
          target: "completed",
          actions: ["logCleanupError", "calculateDeploymentTime"],
        },
      },
    },
    completed: {
      type: "final",
      entry: ["finalizeDeployment", "logFinalState"],
    },
    failed: {
      entry: ["setCurrentStep"],
      on: {
        FORCE_ROLLBACK: "rolling_back",
        RETRY: [
          {
            target: "preparing",
            guard: "canRetry",
            actions: ["resetForRetry"],
          },
        ],
      },
    },
    rolling_back: {
      entry: ["setCurrentStep"],
      invoke: {
        src: "performRollback",
        onDone: {
          target: "completed",
          actions: ["logRollbackCompleted", "calculateDeploymentTime"],
        },
        onError: {
          target: "failed",
          actions: ["handleRollbackError"],
        },
      },
    },
  },
}, {
  actions: {
    initializeDeployment: assign(({ context }) => ({
      ...context,
      startTime: Date.now(),
      currentStep: "preparing",
      retryCount: 0,
      errorMessage: null,
      errorDetails: null,
    })),
    setCurrentStep: assign(({ context }) => ({
      ...context,
      currentStep: context.currentStep,
    })),
    setNewContainerId: assign(({ context, event }) => ({
      ...context,
      newContainerId: (event as any).output?.containerId || null,
    })),
    setHealthCheckPassed: assign(({ context }) => ({
      ...context,
      healthCheckPassed: true,
    })),
    incrementRetryCount: assign(({ context }) => ({
      ...context,
      retryCount: context.retryCount + 1,
    })),
    resetForRetry: assign(({ context }) => ({
      ...context,
      retryCount: 0,
      errorMessage: null,
      errorDetails: null,
    })),
    handleError: assign(({ context, event }) => ({
      ...context,
      errorMessage: (event as any).error || "Unknown error",
      errorDetails: (event as any).data || null,
    })),
    handleImagePullError: assign(({ context, event }) => ({
      ...context,
      errorMessage: `Failed to pull image: ${(event as any).error}`,
      errorDetails: (event as any).data,
    })),
    handleContainerError: assign(({ context, event }) => ({
      ...context,
      errorMessage: `Failed to create/start container: ${(event as any).error}`,
      errorDetails: (event as any).data,
    })),
    handleHealthCheckError: assign(({ context, event }) => ({
      ...context,
      errorMessage: `Health check failed: ${(event as any).error}`,
      errorDetails: (event as any).data,
    })),
    handleTrafficSwitchError: assign(({ context, event }) => ({
      ...context,
      errorMessage: `Failed to switch traffic: ${(event as any).error}`,
      errorDetails: (event as any).data,
    })),
    handleRollbackError: assign(({ context, event }) => ({
      ...context,
      errorMessage: `Rollback failed: ${(event as any).error}`,
      errorDetails: (event as any).data,
    })),
    calculateDeploymentTime: assign(({ context }) => ({
      ...context,
      deploymentTime: Math.floor((Date.now() - context.startTime) / 1000),
    })),
    finalizeDeployment: assign(({ context }) => context),
    logDeploymentStart: ({ context }) => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          applicationName: context.config.applicationName,
          dockerImage: context.dockerImage,
          triggerType: context.triggerType,
        },
        "Deployment started"
      );
    },
    logImagePulled: ({ context }) => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          dockerImage: context.dockerImage,
        },
        "Docker image pulled successfully"
      );
    },
    logContainerCreated: ({ context }) => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
        },
        "Container created and started successfully"
      );
    },
    logHealthCheckPassed: ({ context }) => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
        },
        "Health checks passed"
      );
    },
    logHealthCheckRetry: ({ context }) => {
      deploymentLogger().warn(
        {
          deploymentId: context.deploymentId,
          retryCount: context.retryCount,
          maxRetries: context.maxRetries,
        },
        "Health check failed, retrying"
      );
    },
    logTrafficSwitched: ({ context }) => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          newContainerId: context.newContainerId,
          oldContainerId: context.oldContainerId,
        },
        "Traffic switched to new container"
      );
    },
    logCleanupError: ({ context, event }) => {
      deploymentLogger().warn(
        {
          deploymentId: context.deploymentId,
          oldContainerId: context.oldContainerId,
          error: (event as any).error,
        },
        "Cleanup failed but deployment considered successful"
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
        "Deployment completed successfully"
      );
    },
    logRollbackCompleted: ({ context }) => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          applicationName: context.config.applicationName,
        },
        "Rollback completed successfully"
      );
    },
    logFinalState: ({ context }) => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          deploymentTime: context.deploymentTime,
          errorMessage: context.errorMessage,
        },
        "Deployment reached final state"
      );
    },
  },
  guards: {
    maxRetriesReached: ({ context }) => context.retryCount >= context.maxRetries,
    canRetry: ({ context }) => context.retryCount < context.maxRetries,
  },
});

// ====================
// Deployment Orchestrator
// ====================

export class DeploymentOrchestrator {
  private containerManager: ContainerLifecycleManager;
  private traefikService: TraefikIntegrationService;
  private healthCheckService: HealthCheckService;
  private activeDeployments: Map<string, any> = new Map();

  constructor() {
    this.containerManager = new ContainerLifecycleManager();
    this.traefikService = new TraefikIntegrationService();
    this.healthCheckService = new HealthCheckService();
  }

  // ====================
  // Deployment Management
  // ====================

  /**
   * Start a new deployment
   */
  async startDeployment(
    deploymentId: string,
    config: DeploymentConfig,
    triggerType: DeploymentTriggerType,
    triggeredBy?: string
  ): Promise<void> {
    try {
      deploymentLogger().info(
        {
          deploymentId,
          applicationName: config.applicationName,
          dockerImage: config.dockerImage,
          triggerType,
        },
        "Starting new deployment"
      );

      if (this.activeDeployments.has(deploymentId)) {
        throw new Error(`Deployment ${deploymentId} is already active`);
      }

      // Create deployment context
      const initialContext: DeploymentContext = {
        deploymentId,
        configurationId: "", // Will be set by caller
        config,
        triggerType,
        triggeredBy: triggeredBy || null,
        dockerImage: `${config.dockerImage}:${config.dockerTag}`,
        oldContainerId: null,
        newContainerId: null,
        targetColor: this.determineTargetColor(config.applicationName),
        currentStep: "idle",
        steps: [],
        startTime: Date.now(),
        healthCheckPassed: false,
        healthCheckLogs: [],
        errorMessage: null,
        errorDetails: null,
        retryCount: 0,
        maxRetries: 3,
        deploymentTime: null,
        downtime: 0,
      };

      // Create and start state machine
      const deploymentMachine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(this.createPullImageService(initialContext)),
          createAndStartContainer: fromPromise(this.createContainerService(initialContext)),
          performHealthChecks: fromPromise(this.createHealthCheckService(initialContext)),
          switchTrafficToNewContainer: fromPromise(this.createTrafficSwitchService(initialContext)),
          cleanupOldContainer: fromPromise(this.createCleanupService(initialContext)),
          performRollback: fromPromise(this.createRollbackService(initialContext)),
        },
      });

      const actor = createActor(deploymentMachine, {
        input: initialContext,
      });

      // Store active deployment
      this.activeDeployments.set(deploymentId, actor);

      // Start the actor and trigger deployment
      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Handle completion
      actor.subscribe((state) => {
        if (state.status === "done") {
          this.activeDeployments.delete(deploymentId);
          deploymentLogger().info(
            { deploymentId },
            "Deployment actor completed and cleaned up"
          );
        }

        // Log state changes
        deploymentLogger().debug(
          {
            deploymentId,
            currentState: state.value,
            context: state.context,
          },
          "Deployment state transition"
        );
      });

    } catch (error) {
      deploymentLogger().error(
        {
          deploymentId,
          error: error instanceof Error ? error.message : "Unknown error",
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to start deployment"
      );
      throw error;
    }
  }

  /**
   * Get deployment status
   */
  getDeploymentStatus(deploymentId: string): {
    isActive: boolean;
    currentState: string | null;
    context: DeploymentContext | null;
  } {
    const actor = this.activeDeployments.get(deploymentId);
    
    if (!actor) {
      return {
        isActive: false,
        currentState: null,
        context: null,
      };
    }

    const snapshot = actor.getSnapshot();
    return {
      isActive: snapshot.status !== "done",
      currentState: snapshot.value as string,
      context: snapshot.context,
    };
  }

  /**
   * Force rollback of an active deployment
   */
  async forceRollback(deploymentId: string): Promise<void> {
    const actor = this.activeDeployments.get(deploymentId);
    
    if (!actor) {
      throw new Error(`No active deployment found with ID: ${deploymentId}`);
    }

    deploymentLogger().info(
      { deploymentId },
      "Forcing deployment rollback"
    );

    actor.send({ type: "FORCE_ROLLBACK" });
  }

  /**
   * Stop and cleanup deployment
   */
  async stopDeployment(deploymentId: string): Promise<void> {
    const actor = this.activeDeployments.get(deploymentId);
    
    if (!actor) {
      deploymentLogger().warn(
        { deploymentId },
        "Attempted to stop non-existent deployment"
      );
      return;
    }

    deploymentLogger().info(
      { deploymentId },
      "Stopping deployment"
    );

    actor.stop();
    this.activeDeployments.delete(deploymentId);
  }

  // ====================
  // Service Factory Methods
  // ====================

  private createPullImageService(context: DeploymentContext) {
    return async () => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          dockerImage: context.dockerImage,
        },
        "Pulling Docker image"
      );

      // In a real implementation, this would use DockerService to pull the image
      // For now, we'll simulate the operation
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return { success: true };
    };
  }

  private createContainerService(context: DeploymentContext) {
    return async () => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          applicationName: context.config.applicationName,
          targetColor: context.targetColor,
        },
        "Creating and starting container"
      );

      const containerName = `${context.config.applicationName}-${context.targetColor}`;
      
      // Create container with Traefik labels
      const containerId = await this.containerManager.createContainer({
        name: containerName,
        image: context.config.dockerImage,
        tag: context.config.dockerTag,
        config: context.config.containerConfig,
        traefikConfig: context.config.traefikConfig,
        deploymentId: context.deploymentId,
      });

      // Start the container
      await this.containerManager.startContainer(containerId);

      // Wait for container to be running
      const isRunning = await this.containerManager.waitForContainerStatus(
        containerId,
        "running",
        30000 // 30 seconds timeout
      );

      if (!isRunning) {
        throw new Error("Container failed to reach running state");
      }

      return { containerId };
    };
  }

  private createHealthCheckService(context: DeploymentContext) {
    return async () => {
      if (!context.newContainerId) {
        throw new Error("No container ID available for health checks");
      }

      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
          endpoint: context.config.healthCheck.endpoint,
        },
        "Performing health checks"
      );

      const result = await this.healthCheckService.performHealthCheck({
        endpoint: context.config.healthCheck.endpoint,
        method: context.config.healthCheck.method,
        expectedStatuses: context.config.healthCheck.expectedStatus,
        timeout: context.config.healthCheck.timeout,
        retries: context.config.healthCheck.retries,
        retryDelay: context.config.healthCheck.interval,
        responseBodyPattern: context.config.healthCheck.responseValidation,
      });

      if (!result.success) {
        throw new Error(`Health check failed: ${result.errorMessage}`);
      }

      return { healthCheckResult: result };
    };
  }

  private createTrafficSwitchService(context: DeploymentContext) {
    return async () => {
      if (!context.newContainerId) {
        throw new Error("No new container ID available for traffic switch");
      }

      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          newContainerId: context.newContainerId,
          oldContainerId: context.oldContainerId,
        },
        "Switching traffic to new container"
      );

      // Find and update old container if exists
      if (context.oldContainerId) {
        await this.traefikService.switchTraffic({
          applicationName: context.config.applicationName,
          fromContainerId: context.oldContainerId,
          toContainerId: context.newContainerId,
          traefikConfig: context.config.traefikConfig,
        });
      }

      return { success: true };
    };
  }

  private createCleanupService(context: DeploymentContext) {
    return async () => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          oldContainerId: context.oldContainerId,
        },
        "Cleaning up old container"
      );

      if (context.oldContainerId && context.config.rollbackConfig.keepOldContainer === false) {
        try {
          await this.containerManager.stopContainer(context.oldContainerId);
          await this.containerManager.removeContainer(context.oldContainerId);
        } catch (error) {
          deploymentLogger().warn(
            {
              deploymentId: context.deploymentId,
              oldContainerId: context.oldContainerId,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "Failed to cleanup old container, but deployment continues"
          );
        }
      }

      return { success: true };
    };
  }

  private createRollbackService(context: DeploymentContext) {
    return async () => {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          newContainerId: context.newContainerId,
          oldContainerId: context.oldContainerId,
        },
        "Performing deployment rollback"
      );

      // Stop and remove failed container
      if (context.newContainerId) {
        try {
          await this.containerManager.stopContainer(context.newContainerId);
          await this.containerManager.removeContainer(context.newContainerId);
        } catch (error) {
          deploymentLogger().error(
            {
              deploymentId: context.deploymentId,
              newContainerId: context.newContainerId,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "Failed to cleanup failed container during rollback"
          );
        }
      }

      // Restore traffic to old container if it exists
      if (context.oldContainerId) {
        const status = await this.containerManager.getContainerStatus(context.oldContainerId);
        if (status && status.status !== "running") {
          await this.containerManager.startContainer(context.oldContainerId);
        }
      }

      return { success: true };
    };
  }

  // ====================
  // Helper Methods
  // ====================

  private determineTargetColor(applicationName: string): "blue" | "green" {
    // In a real implementation, this would check existing containers
    // and determine the opposite color
    return Math.random() > 0.5 ? "blue" : "green";
  }

  /**
   * Get all active deployments
   */
  getActiveDeployments(): string[] {
    return Array.from(this.activeDeployments.keys());
  }

  /**
   * Check if deployment is active
   */
  isDeploymentActive(deploymentId: string): boolean {
    return this.activeDeployments.has(deploymentId);
  }
}

export default DeploymentOrchestrator;