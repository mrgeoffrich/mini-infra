import { createActor, fromPromise } from "xstate";
import { deploymentLogger } from "../lib/logger-factory";
import { blueGreenDeploymentMachine } from "./haproxy/blue-green-deployment-state-machine";
import { initialDeploymentMachine } from "./haproxy/initial-deployment-state-machine";
import { removalDeploymentMachine } from "./haproxy/removal-deployment-state-machine";
import { EnvironmentValidationService, HAProxyEnvironmentContext } from "./environment-validation";
import { ContainerLifecycleManager } from "./container-lifecycle-manager";
import { HealthCheckService } from "./health-check";
import { NetworkHealthCheckService } from "./network-health-check";
import { DockerExecutorService } from "./docker-executor";
import DockerService from "./docker";
import prisma from "../lib/prisma";
import {
  DeploymentConfig,
  DeploymentStatus,
  DeploymentTriggerType,
  DeploymentStep,
  DeploymentStepStatus,
  ContainerConfig,
  HealthCheckConfig,
  RollbackConfig,
} from "@mini-infra/types";

// ====================
// Deployment Types
// ====================

export type DeploymentStrategy = "initial" | "blue-green";

export interface HAProxyDeploymentContext {
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

  // Deployment metadata
  triggerType: DeploymentTriggerType;
  triggeredBy?: string;
  startTime: number;

  // Configuration
  config: DeploymentConfig;
}

export interface HAProxyRemovalContext {
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

// ====================
// Deployment Orchestrator
// ====================

export class DeploymentOrchestrator {
  private environmentValidationService: EnvironmentValidationService;
  private containerManager: ContainerLifecycleManager;
  private healthCheckService: HealthCheckService;
  private networkHealthCheckService: NetworkHealthCheckService;
  private dockerExecutor: DockerExecutorService;
  private dockerService: DockerService;
  private activeDeployments: Map<string, any> = new Map();
  private activeRemovalOperations: Map<string, any> = new Map();

  constructor() {
    this.environmentValidationService = new EnvironmentValidationService();
    this.containerManager = new ContainerLifecycleManager();
    this.healthCheckService = new HealthCheckService();
    this.networkHealthCheckService = new NetworkHealthCheckService();
    this.dockerExecutor = new DockerExecutorService();
    this.dockerService = DockerService.getInstance();
  }

  /**
   * Initialize the deployment orchestrator service
   */
  async initialize(): Promise<void> {
    await this.dockerExecutor.initialize();
    await this.networkHealthCheckService.initialize();
    await this.dockerService.initialize();
  }

  // ====================
  // Deployment Strategy Detection
  // ====================

  /**
   * Determine deployment strategy based on existing containers
   */
  async determineDeploymentStrategy(
    applicationName: string,
    environmentContext: HAProxyEnvironmentContext
  ): Promise<DeploymentStrategy> {
    try {
      deploymentLogger().debug(
        {
          applicationName,
          environmentId: environmentContext.environmentId,
          environmentName: environmentContext.environmentName,
        },
        "Determining deployment strategy"
      );

      // Check for existing containers with this application name
      const containers = await this.dockerService.listContainers();
      const existingContainers = containers.filter((container: any) => {
        const labels = container.labels || {};
        return (
          labels["mini-infra.application"] === applicationName &&
          labels["mini-infra.environment"] === environmentContext.environmentId &&
          container.status === "running"
        );
      });

      const strategy: DeploymentStrategy = existingContainers.length > 0 ? "blue-green" : "initial";

      deploymentLogger().info(
        {
          applicationName,
          environmentId: environmentContext.environmentId,
          environmentName: environmentContext.environmentName,
          existingContainerCount: existingContainers.length,
          existingContainers: existingContainers.map((c: any) => ({
            id: c.id.slice(0, 12),
            name: c.name,
            status: c.status,
          })),
          selectedStrategy: strategy,
        },
        "Deployment strategy determined"
      );

      return strategy;
    } catch (error) {
      deploymentLogger().error(
        {
          applicationName,
          environmentId: environmentContext.environmentId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to determine deployment strategy, defaulting to initial"
      );

      // Default to initial deployment if we can't determine
      return "initial";
    }
  }

  // ====================
  // Deployment Management
  // ====================

  /**
   * Start a new deployment with environment validation and strategy selection
   */
  async startDeployment(
    deploymentId: string,
    config: DeploymentConfig,
    triggerType: DeploymentTriggerType,
    triggeredBy?: string,
  ): Promise<void> {
    try {
      deploymentLogger().info(
        {
          deploymentId,
          applicationName: config.applicationName,
          dockerImage: config.dockerImage,
          triggerType,
        },
        "Starting new HAProxy-based deployment",
      );

      if (this.activeDeployments.has(deploymentId)) {
        throw new Error(`Deployment ${deploymentId} is already active`);
      }

      // Get environment context from deployment configuration
      const deploymentRecord = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: {
          configuration: {
            include: {
              environment: true,
            },
          },
        },
      });

      if (!deploymentRecord || !deploymentRecord.configuration.environment) {
        throw new Error(`Unable to find deployment configuration with environment information`);
      }

      const environmentId = deploymentRecord.configuration.environmentId;

      // Validate environment and get HAProxy context
      const environmentContext = await this.environmentValidationService.getHAProxyEnvironmentContext(environmentId);
      if (!environmentContext) {
        const validation = await this.environmentValidationService.validateEnvironmentForDeployment(environmentId);
        throw new Error(validation.errorMessage || "Environment validation failed");
      }

      // Determine deployment strategy
      const strategy = await this.determineDeploymentStrategy(config.applicationName, environmentContext);

      // Create base deployment context
      const baseContext: HAProxyDeploymentContext = {
        deploymentId,
        configurationId: deploymentRecord.configurationId,
        applicationName: config.applicationName,
        dockerImage: `${config.dockerImage}:${config.dockerTag}`,
        environmentId: environmentContext.environmentId,
        environmentName: environmentContext.environmentName,
        haproxyContainerId: environmentContext.haproxyContainerId,
        haproxyNetworkName: environmentContext.haproxyNetworkName,
        triggerType,
        triggeredBy,
        startTime: Date.now(),
        config,
      };

      // Start appropriate state machine based on strategy
      if (strategy === "initial") {
        await this.startInitialDeployment(baseContext);
      } else {
        await this.startBlueGreenDeployment(baseContext);
      }

    } catch (error) {
      deploymentLogger().error(
        {
          deploymentId,
          error: error instanceof Error ? error.message : "Unknown error",
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to start deployment",
      );
      throw error;
    }
  }

  /**
   * Start initial deployment using initial deployment state machine
   */
  private async startInitialDeployment(baseContext: HAProxyDeploymentContext): Promise<void> {
    const deploymentId = baseContext.deploymentId;

    deploymentLogger().info(
      {
        deploymentId,
        applicationName: baseContext.applicationName,
        environmentName: baseContext.environmentName,
        strategy: "initial",
      },
      "Starting initial deployment with HAProxy state machine"
    );

    // Create initial deployment context
    const initialContext = {
      ...baseContext,
      // Initial deployment specific fields
      containerId: undefined,
      applicationReady: false,
      haproxyConfigured: false,
      healthChecksPassed: false,
      trafficEnabled: false,
      validationErrors: 0,
      monitoringStartTime: undefined,
      error: undefined,
      retryCount: 0,
    };

    // Create state machine with service implementations
    const deploymentMachine = initialDeploymentMachine.provide({
      // Add service implementations here when HAProxy actions are implemented
      // For now, the action stubs will handle logging
    });

    const actor = createActor(deploymentMachine, {
      input: initialContext,
    });

    // Store and start deployment
    this.activeDeployments.set(deploymentId, actor);
    this.setupActorSubscription(actor, deploymentId, "initial");

    actor.start();
    actor.send({ type: "START_DEPLOYMENT" });
  }

  /**
   * Start blue-green deployment using blue-green state machine
   */
  private async startBlueGreenDeployment(baseContext: HAProxyDeploymentContext): Promise<void> {
    const deploymentId = baseContext.deploymentId;

    deploymentLogger().info(
      {
        deploymentId,
        applicationName: baseContext.applicationName,
        environmentName: baseContext.environmentName,
        strategy: "blue-green",
      },
      "Starting blue-green deployment with HAProxy state machine"
    );

    // Create blue-green deployment context
    const blueGreenContext = {
      ...baseContext,
      // Blue-green deployment specific fields
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
      oldContainerId: undefined,
      newContainerId: undefined,
    };

    // Create state machine with service implementations
    const deploymentMachine = blueGreenDeploymentMachine.provide({
      // Add service implementations here when HAProxy actions are implemented
      // For now, the action stubs will handle logging
    });

    const actor = createActor(deploymentMachine, {
      input: blueGreenContext,
    });

    // Store and start deployment
    this.activeDeployments.set(deploymentId, actor);
    this.setupActorSubscription(actor, deploymentId, "blue-green");

    actor.start();
    actor.send({ type: "START_DEPLOYMENT" });
  }

  /**
   * Setup actor subscription for state machine monitoring
   */
  private setupActorSubscription(actor: any, deploymentId: string, strategy: DeploymentStrategy): void {
    actor.subscribe(async (state: any) => {
      if (state.status === "done") {
        this.activeDeployments.delete(deploymentId);

        // Update deployment status in database based on final state
        try {
          const finalStatus = state.value === "completed" ? "completed" : "failed";
          const hasError = state.context.error !== undefined && state.context.error !== null;

          await prisma.deployment.update({
            where: { id: deploymentId },
            data: {
              status: finalStatus,
              currentState: state.value as string,
              completedAt: new Date(),
              errorMessage: state.context.error || null,
              deploymentTime: state.context.startTime ?
                (Date.now() - state.context.startTime) / 1000 : null,
            },
          });

          deploymentLogger().info(
            {
              deploymentId,
              finalStatus,
              finalState: state.value,
              strategy,
              hasError,
              environmentName: state.context.environmentName,
            },
            "HAProxy deployment actor completed and database updated",
          );
        } catch (error) {
          deploymentLogger().error(
            {
              deploymentId,
              strategy,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "Failed to update deployment status in database",
          );
        }
      }

      // Log state changes
      deploymentLogger().debug(
        {
          deploymentId,
          strategy,
          currentState: state.value,
          environmentName: state.context.environmentName,
          applicationName: state.context.applicationName,
        },
        "HAProxy deployment state transition",
      );
    });
  }

  /**
   * Get deployment status
   */
  getDeploymentStatus(deploymentId: string): {
    isActive: boolean;
    currentState: string | null;
    context: any | null;
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
   * Force rollback of an active deployment (not applicable to state machine approach)
   */
  async forceRollback(deploymentId: string): Promise<void> {
    const actor = this.activeDeployments.get(deploymentId);

    if (!actor) {
      throw new Error(`No active deployment found with ID: ${deploymentId}`);
    }

    deploymentLogger().warn(
      { deploymentId },
      "Force rollback not supported with HAProxy state machines - deployments will handle failures automatically"
    );

    // HAProxy state machines handle rollback automatically through their error states
    // We don't force external rollbacks
  }

  /**
   * Stop and cleanup deployment
   */
  async stopDeployment(deploymentId: string): Promise<void> {
    const actor = this.activeDeployments.get(deploymentId);

    if (!actor) {
      deploymentLogger().warn(
        { deploymentId },
        "Attempted to stop non-existent deployment",
      );
      return;
    }

    deploymentLogger().info({ deploymentId }, "Stopping HAProxy deployment");

    actor.stop();
    this.activeDeployments.delete(deploymentId);
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

  /**
   * Get all active removal operations
   */
  getActiveRemovalOperations(): string[] {
    return Array.from(this.activeRemovalOperations.keys());
  }

  /**
   * Check if removal operation is active
   */
  isRemovalOperationActive(removalId: string): boolean {
    return this.activeRemovalOperations.has(removalId);
  }

  /**
   * Get removal operation status
   */
  getRemovalOperationStatus(removalId: string): {
    isActive: boolean;
    currentState: string | null;
    context: any | null;
  } {
    const actor = this.activeRemovalOperations.get(removalId);

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

  // ====================
  // API Interface Methods
  // ====================

  /**
   * Trigger a new deployment from API with environment validation
   */
  async triggerDeployment(params: {
    configurationId: string;
    triggerType: DeploymentTriggerType;
    triggeredBy?: string;
    dockerImage: string;
    force?: boolean;
  }): Promise<any> {
    try {
      // Get configuration with environment information
      const config = await prisma.deploymentConfiguration.findUnique({
        where: { id: params.configurationId },
        include: {
          environment: true,
        },
      });

      if (!config) {
        throw new Error(
          `Deployment configuration ${params.configurationId} not found`,
        );
      }

      // Validate environment before creating deployment
      const environmentValidation = await this.environmentValidationService.validateEnvironmentForDeployment(
        config.environmentId
      );

      if (!environmentValidation.isValid) {
        throw new Error(environmentValidation.errorMessage || "Environment validation failed");
      }

      // Create deployment record
      const deployment = await prisma.deployment.create({
        data: {
          configurationId: params.configurationId,
          triggerType: params.triggerType,
          triggeredBy: params.triggeredBy || null,
          dockerImage: params.dockerImage,
          status: "pending",
          currentState: "idle",
          startedAt: new Date(),
          healthCheckPassed: false,
          downtime: 0,
        },
      });

      deploymentLogger().info(
        {
          deploymentId: deployment.id,
          configId: params.configurationId,
          applicationName: config.applicationName,
          dockerImage: params.dockerImage,
          triggerType: params.triggerType,
          environmentId: config.environmentId,
          environmentName: config.environment?.name,
        },
        "HAProxy deployment triggered in validated environment",
      );

      // Prepare deployment config
      const deploymentConfig: DeploymentConfig = {
        applicationName: config.applicationName,
        dockerImage: config.dockerImage,
        dockerTag: params.dockerImage.split(":")[1] || "latest",
        containerConfig: config.containerConfig as unknown as ContainerConfig,
        healthCheck: config.healthCheckConfig as unknown as HealthCheckConfig,
        rollbackConfig: config.rollbackConfig as unknown as RollbackConfig,
        listeningPort: config.listeningPort,
      };

      // Start deployment asynchronously
      setImmediate(async () => {
        try {
          await this.startDeployment(
            deployment.id,
            deploymentConfig,
            params.triggerType,
            params.triggeredBy,
          );
        } catch (error) {
          deploymentLogger().error(
            {
              deploymentId: deployment.id,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "HAProxy deployment failed during execution",
          );

          // Update deployment status to failed
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              errorMessage:
                error instanceof Error ? error.message : "Unknown error",
            },
          });
        }
      });

      return deployment;
    } catch (error) {
      deploymentLogger().error(
        {
          configurationId: params.configurationId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to trigger HAProxy deployment",
      );
      throw error;
    }
  }

  /**
   * Rollback a deployment from API (not supported with state machines)
   */
  async rollbackDeployment(deploymentId: string): Promise<any> {
    const deployment = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { configuration: true },
    });

    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    deploymentLogger().warn(
      { deploymentId },
      "Manual rollback not supported with HAProxy state machines - deployments handle rollback automatically"
    );

    return deployment;
  }

  /**
   * Execute removal state machine for deployment configuration
   */
  async executeRemovalStateMachine(params: {
    configurationId: string;
    applicationName: string;
    triggeredBy?: string;
  }): Promise<string> {
    try {
      deploymentLogger().info(
        {
          configurationId: params.configurationId,
          applicationName: params.applicationName,
          triggeredBy: params.triggeredBy,
        },
        "Starting deployment removal with HAProxy state machine"
      );

      // Get configuration with environment information
      const config = await prisma.deploymentConfiguration.findUnique({
        where: { id: params.configurationId },
        include: {
          environment: true,
        },
      });

      if (!config) {
        throw new Error(`Deployment configuration ${params.configurationId} not found`);
      }

      // Validate environment and get HAProxy context
      const environmentContext = await this.environmentValidationService.getHAProxyEnvironmentContext(
        config.environmentId
      );
      if (!environmentContext) {
        const validation = await this.environmentValidationService.validateEnvironmentForDeployment(
          config.environmentId
        );
        throw new Error(validation.errorMessage || "Environment validation failed");
      }

      // Generate unique removal operation ID
      const removalId = `removal-${params.configurationId}-${Date.now()}`;

      // Find containers to remove
      const containers = await this.dockerService.listContainers();
      const appContainers = containers.filter((container: any) => {
        const labels = container.labels || {};
        return (
          labels["mini-infra.application"] === params.applicationName &&
          labels["mini-infra.environment"] === environmentContext.environmentId
        );
      });

      // Create removal context
      const removalContext: HAProxyRemovalContext = {
        deploymentId: removalId,
        configurationId: params.configurationId,
        applicationName: params.applicationName,
        environmentId: environmentContext.environmentId,
        environmentName: environmentContext.environmentName,
        haproxyContainerId: environmentContext.haproxyContainerId,
        haproxyNetworkName: environmentContext.haproxyNetworkName,
        containersToRemove: appContainers.map((c: any) => c.id),
        lbRemovalComplete: false,
        applicationStopped: false,
        applicationRemoved: false,
        retryCount: 0,
        triggerType: "manual",
        triggeredBy: params.triggeredBy,
        startTime: Date.now(),
      };

      // Create and start removal state machine
      const removalMachine = removalDeploymentMachine.provide({
        // Service implementations will be added here when ready
      });

      const actor = createActor(removalMachine, {
        input: removalContext,
      });

      // Store and start removal operation
      this.activeRemovalOperations.set(removalId, actor);
      this.setupRemovalActorSubscription(actor, removalId);

      actor.start();
      actor.send({ type: "START_REMOVAL" });

      deploymentLogger().info(
        {
          removalId,
          configurationId: params.configurationId,
          applicationName: params.applicationName,
          containerCount: appContainers.length,
        },
        "HAProxy removal state machine started"
      );

      return removalId;
    } catch (error) {
      deploymentLogger().error(
        {
          configurationId: params.configurationId,
          applicationName: params.applicationName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to start removal state machine"
      );
      throw error;
    }
  }

  /**
   * Setup actor subscription for removal state machine monitoring
   */
  private setupRemovalActorSubscription(actor: any, removalId: string): void {
    actor.subscribe(async (state: any) => {
      if (state.status === "done") {
        this.activeRemovalOperations.delete(removalId);

        const finalStatus = state.value === "completed" ? "completed" : "failed";
        const hasError = state.context.error !== undefined && state.context.error !== null;

        deploymentLogger().info(
          {
            removalId,
            finalStatus,
            finalState: state.value,
            hasError,
            applicationName: state.context.applicationName,
            environmentName: state.context.environmentName,
          },
          "HAProxy removal state machine completed"
        );

        // Notify completion (could be used for UI updates, etc.)
        if (finalStatus === "completed") {
          deploymentLogger().info(
            {
              removalId,
              applicationName: state.context.applicationName,
            },
            "Deployment removal completed successfully - configuration can be safely deleted"
          );
        } else {
          deploymentLogger().error(
            {
              removalId,
              applicationName: state.context.applicationName,
              error: state.context.error,
            },
            "Deployment removal failed - manual intervention may be required"
          );
        }
      }

      // Log state changes
      deploymentLogger().debug(
        {
          removalId,
          currentState: state.value,
          applicationName: state.context.applicationName,
          environmentName: state.context.environmentName,
        },
        "HAProxy removal state transition"
      );
    });
  }
}

export default DeploymentOrchestrator;