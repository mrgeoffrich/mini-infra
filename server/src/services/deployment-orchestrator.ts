import { createActor, fromPromise } from "xstate";
import { deploymentLogger } from "../lib/logger-factory";
import { deploymentStateMachine, DeploymentContext, DeploymentEvent } from "./deployment-state-machine";
import { ContainerLifecycleManager } from "./container-lifecycle-manager";
import { TraefikIntegrationService } from "./traefik-integration";
import { HealthCheckService } from "./health-check";
import { NetworkHealthCheckService } from "./network-health-check";
import { DockerExecutorService } from "./docker-executor";
import prisma from "../lib/prisma";
import {
  DeploymentConfig,
  DeploymentStatus,
  DeploymentTriggerType,
  DeploymentStep,
  DeploymentStepStatus,
  TraefikConfig,
  ContainerConfig,
  HealthCheckConfig,
  RollbackConfig,
} from "@mini-infra/types";

// State machine types and configuration imported from ./deployment-state-machine.ts

// ====================
// Deployment Orchestrator
// ====================

export class DeploymentOrchestrator {
  private containerManager: ContainerLifecycleManager;
  private traefikService: TraefikIntegrationService;
  private healthCheckService: HealthCheckService;
  private networkHealthCheckService: NetworkHealthCheckService;
  private dockerExecutor: DockerExecutorService;
  private activeDeployments: Map<string, any> = new Map();

  constructor() {
    this.containerManager = new ContainerLifecycleManager();
    this.traefikService = new TraefikIntegrationService();
    this.healthCheckService = new HealthCheckService();
    this.networkHealthCheckService = new NetworkHealthCheckService();
    this.dockerExecutor = new DockerExecutorService();
  }

  /**
   * Initialize the deployment orchestrator service
   */
  async initialize(): Promise<void> {
    await this.dockerExecutor.initialize();
    await this.networkHealthCheckService.initialize();
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
        "Starting new deployment",
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
          pullDockerImage: fromPromise(
            async ({ input }: { input: DeploymentContext }) => {
              return await this.pullDockerImage(input);
            }
          ),
          createAndStartContainer: fromPromise(
            async ({ input }: { input: DeploymentContext }) => {
              return await this.createAndStartContainer(input);
            }
          ),
          performHealthChecks: fromPromise(
            async ({ input }: { input: DeploymentContext }) => {
              return await this.performHealthCheck(input);
            }
          ),
          switchTrafficToNewContainer: fromPromise(
            async ({ input }: { input: DeploymentContext }) => {
              return await this.switchTrafficToNewContainer(input);
            }
          ),
          cleanupOldContainer: fromPromise(
            async ({ input }: { input: DeploymentContext }) => {
              return await this.cleanupOldContainer(input);
            }
          ),
          performRollback: fromPromise(
            async ({ input }: { input: DeploymentContext }) => {
              return await this.performRollback(input);
            }
          ),
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
      actor.subscribe(async (state) => {
        if (state.status === "done") {
          this.activeDeployments.delete(deploymentId);
          
          // Update deployment status in database based on final state
          try {
            const finalStatus = state.value === "completed" ? "completed" : "failed";
            const hasError = state.context.errorMessage !== null;
            
            await prisma.deployment.update({
              where: { id: deploymentId },
              data: {
                status: finalStatus,
                currentState: state.value as string,
                completedAt: new Date(),
                healthCheckPassed: state.context.healthCheckPassed,
                deploymentTime: state.context.deploymentTime,
                downtime: state.context.downtime,
                errorMessage: state.context.errorMessage,
                errorDetails: state.context.errorDetails,
              },
            });

            deploymentLogger().info(
              { 
                deploymentId,
                finalStatus,
                finalState: state.value,
                deploymentTime: state.context.deploymentTime,
                downtime: state.context.downtime,
                hasError,
              },
              "Deployment actor completed and database updated",
            );
          } catch (error) {
            deploymentLogger().error(
              {
                deploymentId,
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
            currentState: state.value,
            context: state.context,
          },
          "Deployment state transition",
        );
      });
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

    deploymentLogger().info({ deploymentId }, "Forcing deployment rollback");

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
        "Attempted to stop non-existent deployment",
      );
      return;
    }

    deploymentLogger().info({ deploymentId }, "Stopping deployment");

    actor.stop();
    this.activeDeployments.delete(deploymentId);
  }

  // ====================
  // Health Check Service (receives current context)
  // ====================

  private async performHealthCheck(context: DeploymentContext) {
    try {
      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          newContainerId: context.newContainerId,
        },
        "Starting health check process",
      );

      if (!context.newContainerId) {
        deploymentLogger().error(
          { deploymentId: context.deploymentId },
          "Health check failed: No container ID available",
        );
        throw new Error("No container ID available for health checks");
      }

      // Update deployment step in database
      await this.updateDeploymentStep(
        context.deploymentId,
        "health_check",
        "running",
        "Performing network-aware health checks",
      );

      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
        },
        "Performing network-aware health checks",
      );

      // Ensure container is running
      deploymentLogger().debug(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
        },
        "Checking container status for health check",
      );
      
      const containerInfo = await this.containerManager.getContainerStatus(context.newContainerId);
      
      deploymentLogger().debug(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
          containerInfo,
        },
        "Container status check result",
      );
      
      if (!containerInfo || containerInfo.status !== "running") {
        deploymentLogger().error(
          {
            deploymentId: context.deploymentId,
            containerId: context.newContainerId,
            containerStatus: containerInfo?.status,
            hasContainerInfo: !!containerInfo,
          },
          "Health check failed: Container is not running",
        );
        throw new Error("Container is not running");
      }

      // Get container name and port for network health check
      const healthCheckConfig = context.config.healthCheck;
      const containerName = `${context.config.applicationName}-${context.targetColor}`;
      
      deploymentLogger().debug(
        {
          deploymentId: context.deploymentId,
          healthCheckConfig,
          containerName,
          availablePorts: context.config.containerConfig.ports,
        },
        "Preparing network health check configuration",
      );
      
      // Determine container port for health check
      let containerPort: number;
      
      if (context.config.listeningPort) {
        // Use the explicitly configured listening port
        containerPort = context.config.listeningPort;
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            listeningPort: context.config.listeningPort,
          },
          "Using configured listening port for health check",
        );
      } else {
        // Fall back to port discovery (prioritize port 80, then first available port)
        const portConfig = context.config.containerConfig.ports.find(p => p.containerPort === 80) ||
                          context.config.containerConfig.ports[0];
        
        if (!portConfig) {
          deploymentLogger().error(
            {
              deploymentId: context.deploymentId,
              availablePorts: context.config.containerConfig.ports,
              containerConfigExists: !!context.config.containerConfig,
            },
            "Health check failed: No container port configuration found",
          );
          throw new Error("No container port configuration found for health check");
        }

        containerPort = portConfig.containerPort;
        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            discoveredPort: containerPort,
            portConfig,
          },
          "Using discovered container port for health check",
        );
      }

      deploymentLogger().debug(
        {
          deploymentId: context.deploymentId,
          containerName,
          containerPort,
          endpoint: healthCheckConfig.endpoint,
        },
        "Performing network health check using curl container",
      );

      // Convert to network health check configuration
      const networkConfig = this.networkHealthCheckService.convertHealthCheckConfig(
        containerName,
        containerPort,
        healthCheckConfig,
      );

      // Perform network health check using curl container
      const result = await this.networkHealthCheckService.performNetworkHealthCheck(networkConfig);

      // Check if health check actually passed
      if (!result.success) {
        // Log the failure details
        deploymentLogger().error(
          {
            deploymentId: context.deploymentId,
            containerId: context.newContainerId,
            containerName,
            containerPort,
            healthCheckResult: result,
            validationDetails: result.validationDetails,
            errorMessage: result.errorMessage,
          },
          "Network health check failed validation",
        );

        // Update step as failed
        await this.updateDeploymentStep(
          context.deploymentId,
          "health_check",
          "failed",
          result.errorMessage || "Network health check failed",
        );

        // Store health check results as failed
        await this.updateDeploymentHealthCheck(
          context.deploymentId,
          false,
          result,
        );

        // Throw error to trigger retry or rollback
        throw new Error(result.errorMessage || "Network health check failed");
      }

      // Update step as completed
      await this.updateDeploymentStep(
        context.deploymentId,
        "health_check",
        "completed",
        "Network health checks passed successfully",
      );

      // Store health check results in database
      await this.updateDeploymentHealthCheck(
        context.deploymentId,
        true,
        result,
      );

      deploymentLogger().info(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
          containerName,
          containerPort,
          healthCheckResult: result,
        },
        "Network health checks passed successfully",
      );

      return { healthCheckResult: result };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      deploymentLogger().error(
        {
          deploymentId: context.deploymentId,
          containerId: context.newContainerId,
          error: errorMessage,
        },
        "Network health check failed",
      );

      throw new Error(errorMessage);
    }
  }

  // ====================
  // Service Factory Methods
  // ====================

  private async pullDockerImage(context: DeploymentContext) {
      try {
        // Update deployment step in database
        await this.updateDeploymentStep(
          context.deploymentId,
          "pull_image",
          "running",
          "Pulling Docker image",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            dockerImage: context.dockerImage,
          },
          "Pulling Docker image",
        );

        // Initialize docker executor if needed
        await this.dockerExecutor.initialize();

        // Pull the image (this will handle authentication if configured)
        await this.dockerExecutor.pullImageWithAuth(context.dockerImage);

        // Update step as completed
        await this.updateDeploymentStep(
          context.deploymentId,
          "pull_image",
          "completed",
          "Docker image pulled successfully",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            dockerImage: context.dockerImage,
          },
          "Docker image pulled successfully",
        );

        return { success: true };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Update step as failed
        await this.updateDeploymentStep(
          context.deploymentId,
          "pull_image",
          "failed",
          `Failed to pull image: ${errorMessage}`,
        );

        deploymentLogger().error(
          {
            deploymentId: context.deploymentId,
            dockerImage: context.dockerImage,
            error: errorMessage,
          },
          "Failed to pull Docker image",
        );

        throw error;
      }
  }

  private async createAndStartContainer(context: DeploymentContext) {
      try {
        // Update deployment step in database
        await this.updateDeploymentStep(
          context.deploymentId,
          "create_container",
          "running",
          "Creating and starting container",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            applicationName: context.config.applicationName,
            targetColor: context.targetColor,
          },
          "Creating and starting container",
        );

        // Find old container to switch from
        const oldContainerId = await this.findCurrentContainer(
          context.config.applicationName,
          context.targetColor === "blue" ? "green" : "blue",
        );
        if (oldContainerId) {
          context.oldContainerId = oldContainerId;
        }

        const containerName = `${context.config.applicationName}-${context.targetColor}`;

        // Create container with Traefik labels (disabled initially for blue-green deployment)
        const traefikConfig = {
          ...context.config.traefikConfig,
          routerName: `${context.config.traefikConfig.routerName}-${context.targetColor}`,
          serviceName: `${context.config.traefikConfig.serviceName}-${context.targetColor}`,
        };

        const containerId = await this.containerManager.createContainer({
          name: containerName,
          image: context.config.dockerImage,
          tag: context.config.dockerTag,
          config: context.config.containerConfig,
          traefikConfig: traefikConfig,
          deploymentId: context.deploymentId,
          labels: {
            "mini-infra.application": context.config.applicationName,
            "mini-infra.deployment.color": context.targetColor,
            "mini-infra.deployment.active": "false", // Will be set to true after health checks
          },
        });

        // Start the container
        await this.containerManager.startContainer(containerId);

        // Wait for container to be running
        const isRunning = await this.containerManager.waitForContainerStatus(
          containerId,
          "running",
          30000, // 30 seconds timeout
        );

        if (!isRunning) {
          throw new Error("Container failed to reach running state");
        }

        // Update step as completed
        await this.updateDeploymentStep(
          context.deploymentId,
          "create_container",
          "completed",
          `Container created and started: ${containerId}`,
        );

        // Update deployment with container ID
        await this.updateDeploymentContainers(
          context.deploymentId,
          containerId,
          context.oldContainerId,
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            containerId: containerId,
            oldContainerId: context.oldContainerId,
          },
          "Container created and started successfully",
        );

        return { containerId };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Update step as failed
        await this.updateDeploymentStep(
          context.deploymentId,
          "create_container",
          "failed",
          `Failed to create container: ${errorMessage}`,
        );

        throw error;
      }
  }

  private async performStandardHealthCheck(context: DeploymentContext) {
      try {
        if (!context.newContainerId) {
          throw new Error("No container ID available for health checks");
        }

        // Update deployment step in database
        await this.updateDeploymentStep(
          context.deploymentId,
          "health_check",
          "running",
          "Performing health checks",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            containerId: context.newContainerId,
            endpoint: context.config.healthCheck.endpoint,
            retryAttempt: context.retryCount + 1,
            maxRetries: context.maxRetries,
          },
          "Performing health checks",
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
          const errorMessage = `Health check failed: ${result.errorMessage}`;

          // Update step as failed (will retry if within limits)
          await this.updateDeploymentStep(
            context.deploymentId,
            "health_check",
            "failed",
            `${errorMessage} (attempt ${context.retryCount + 1}/${context.maxRetries})`,
          );

          deploymentLogger().warn(
            {
              deploymentId: context.deploymentId,
              containerId: context.newContainerId,
              retryAttempt: context.retryCount + 1,
              maxRetries: context.maxRetries,
              healthCheckResult: result,
            },
            errorMessage,
          );

          throw new Error(errorMessage);
        }

        // Update step as completed
        await this.updateDeploymentStep(
          context.deploymentId,
          "health_check",
          "completed",
          "Health checks passed successfully",
        );

        // Store health check results in context and database
        context.healthCheckLogs.push(result);
        await this.updateDeploymentHealthCheck(
          context.deploymentId,
          true,
          result,
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            containerId: context.newContainerId,
            healthCheckResult: result,
          },
          "Health checks passed successfully",
        );

        return { healthCheckResult: result };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Don't update step status here for failures - let the retry logic handle it
        deploymentLogger().error(
          {
            deploymentId: context.deploymentId,
            containerId: context.newContainerId,
            error: errorMessage,
          },
          "Health check failed",
        );

        throw error;
      }
  }

  private async switchTrafficToNewContainer(context: DeploymentContext) {
      try {
        if (!context.newContainerId) {
          throw new Error("No new container ID available for traffic switch");
        }

        // Update deployment step in database
        await this.updateDeploymentStep(
          context.deploymentId,
          "switch_traffic",
          "running",
          "Switching traffic to new container",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            newContainerId: context.newContainerId,
            oldContainerId: context.oldContainerId,
            applicationName: context.config.applicationName,
          },
          "Switching traffic to new container",
        );

        // Calculate downtime start
        const downtimeStart = Date.now();

        // Switch traffic using Traefik integration
        if (context.oldContainerId) {
          await this.traefikService.switchTraffic({
            applicationName: context.config.applicationName,
            fromContainerId: context.oldContainerId,
            toContainerId: context.newContainerId,
            traefikConfig: context.config.traefikConfig,
          });
        } else {
          // First deployment - just enable traffic to new container by updating labels
          const activeLabels = this.generateActiveTraefikLabels(
            context.config.applicationName,
            context.config.traefikConfig,
            context.config.containerConfig,
            context.targetColor,
          );
          await this.traefikService.updateContainerLabels(
            context.newContainerId,
            activeLabels,
          );
        }

        // Calculate downtime duration
        const downtimeEnd = Date.now();
        context.downtime = downtimeEnd - downtimeStart;

        // Mark container as active
        await this.updateContainerActiveStatus(context.newContainerId, true);
        if (context.oldContainerId) {
          await this.updateContainerActiveStatus(context.oldContainerId, false);
        }

        // Update step as completed
        await this.updateDeploymentStep(
          context.deploymentId,
          "switch_traffic",
          "completed",
          `Traffic switched successfully. Downtime: ${context.downtime}ms`,
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            newContainerId: context.newContainerId,
            oldContainerId: context.oldContainerId,
            downtime: context.downtime,
          },
          "Traffic switched successfully",
        );

        return { success: true, downtime: context.downtime };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Update step as failed
        await this.updateDeploymentStep(
          context.deploymentId,
          "switch_traffic",
          "failed",
          `Failed to switch traffic: ${errorMessage}`,
        );

        deploymentLogger().error(
          {
            deploymentId: context.deploymentId,
            newContainerId: context.newContainerId,
            oldContainerId: context.oldContainerId,
            error: errorMessage,
          },
          "Failed to switch traffic",
        );

        throw error;
      }
  }

  private async cleanupOldContainer(context: DeploymentContext) {
      try {
        // Update deployment step in database
        await this.updateDeploymentStep(
          context.deploymentId,
          "cleanup",
          "running",
          "Cleaning up old container",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            oldContainerId: context.oldContainerId,
            keepOldContainer: context.config.rollbackConfig.keepOldContainer,
          },
          "Cleaning up old container",
        );

        if (
          context.oldContainerId &&
          context.config.rollbackConfig.keepOldContainer === false
        ) {
          try {
            // Stop and remove old container
            await this.containerManager.stopContainer(context.oldContainerId);
            await this.containerManager.removeContainer(context.oldContainerId);

            deploymentLogger().info(
              {
                deploymentId: context.deploymentId,
                oldContainerId: context.oldContainerId,
              },
              "Old container cleaned up successfully",
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error";

            deploymentLogger().warn(
              {
                deploymentId: context.deploymentId,
                oldContainerId: context.oldContainerId,
                error: errorMessage,
              },
              "Failed to cleanup old container, but deployment continues",
            );

            // Don't fail deployment on cleanup errors
          }
        } else if (context.oldContainerId) {
          deploymentLogger().info(
            {
              deploymentId: context.deploymentId,
              oldContainerId: context.oldContainerId,
            },
            "Keeping old container for potential rollback",
          );
        }

        // Update step as completed
        await this.updateDeploymentStep(
          context.deploymentId,
          "cleanup",
          "completed",
          "Cleanup completed",
        );

        return { success: true };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Update step as completed even on error (cleanup failures shouldn't fail deployment)
        await this.updateDeploymentStep(
          context.deploymentId,
          "cleanup",
          "completed",
          `Cleanup completed with warnings: ${errorMessage}`,
        );

        deploymentLogger().warn(
          {
            deploymentId: context.deploymentId,
            error: errorMessage,
          },
          "Cleanup completed with warnings",
        );

        return { success: true };
      }
  }

  private async performRollback(context: DeploymentContext) {
      try {
        // Update deployment step in database
        await this.updateDeploymentStep(
          context.deploymentId,
          "rollback",
          "running",
          "Rolling back deployment",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            newContainerId: context.newContainerId,
            oldContainerId: context.oldContainerId,
          },
          "Performing deployment rollback",
        );

        // Stop and remove failed container
        if (context.newContainerId) {
          try {
            await this.containerManager.stopContainer(context.newContainerId);
            await this.containerManager.removeContainer(context.newContainerId);

            deploymentLogger().info(
              {
                deploymentId: context.deploymentId,
                newContainerId: context.newContainerId,
              },
              "Failed container cleaned up during rollback",
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error";

            deploymentLogger().error(
              {
                deploymentId: context.deploymentId,
                newContainerId: context.newContainerId,
                error: errorMessage,
              },
              "Failed to cleanup failed container during rollback",
            );
          }
        }

        // Restore traffic to old container if it exists
        if (context.oldContainerId) {
          try {
            const status = await this.containerManager.getContainerStatus(
              context.oldContainerId,
            );

            // Start old container if it's not running
            if (status && status.status !== "running") {
              await this.containerManager.startContainer(
                context.oldContainerId,
              );

              // Wait for it to be running
              const isRunning =
                await this.containerManager.waitForContainerStatus(
                  context.oldContainerId,
                  "running",
                  30000,
                );

              if (!isRunning) {
                throw new Error(
                  "Failed to restart old container during rollback",
                );
              }
            }

            // Restore traffic to old container by updating labels
            const activeLabels = this.generateActiveTraefikLabels(
              context.config.applicationName,
              context.config.traefikConfig,
              context.config.containerConfig,
              context.targetColor === "blue" ? "green" : "blue", // Switch back to old color
            );
            await this.traefikService.updateContainerLabels(
              context.oldContainerId,
              activeLabels,
            );

            // Mark old container as active
            await this.updateContainerActiveStatus(
              context.oldContainerId,
              true,
            );

            deploymentLogger().info(
              {
                deploymentId: context.deploymentId,
                oldContainerId: context.oldContainerId,
              },
              "Traffic restored to previous container",
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error";

            deploymentLogger().error(
              {
                deploymentId: context.deploymentId,
                oldContainerId: context.oldContainerId,
                error: errorMessage,
              },
              "Failed to restore traffic to old container during rollback",
            );

            throw error;
          }
        }

        // Update step as completed
        await this.updateDeploymentStep(
          context.deploymentId,
          "rollback",
          "completed",
          "Rollback completed successfully",
        );

        deploymentLogger().info(
          {
            deploymentId: context.deploymentId,
            applicationName: context.config.applicationName,
          },
          "Deployment rollback completed successfully",
        );

        return { success: true };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Update step as failed
        await this.updateDeploymentStep(
          context.deploymentId,
          "rollback",
          "failed",
          `Rollback failed: ${errorMessage}`,
        );

        deploymentLogger().error(
          {
            deploymentId: context.deploymentId,
            error: errorMessage,
          },
          "Deployment rollback failed",
        );

        throw error;
      }
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

  // ====================
  // Database Helper Methods
  // ====================

  /**
   * Update deployment step in database
   */
  private async updateDeploymentStep(
    deploymentId: string,
    stepName: string,
    status: DeploymentStepStatus,
    output?: string,
  ): Promise<void> {
    try {
      await prisma.deploymentStep.upsert({
        where: {
          id: `${deploymentId}-${stepName}`, // Use a composite ID for unique constraint
        },
        update: {
          status,
          output,
          completedAt:
            status === "completed" || status === "failed"
              ? new Date()
              : undefined,
          duration:
            status === "completed" || status === "failed"
              ? Date.now() -
                (await this.getStepStartTime(deploymentId, stepName))
              : undefined,
        },
        create: {
          id: `${deploymentId}-${stepName}`,
          deploymentId,
          stepName,
          status,
          output,
          startedAt: new Date(),
          completedAt:
            status === "completed" || status === "failed"
              ? new Date()
              : undefined,
          duration:
            status === "completed" || status === "failed" ? 0 : undefined,
        },
      });
    } catch (error) {
      deploymentLogger().error(
        {
          deploymentId,
          stepName,
          status,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update deployment step",
      );
    }
  }

  /**
   * Get step start time for duration calculation
   */
  private async getStepStartTime(
    deploymentId: string,
    stepName: string,
  ): Promise<number> {
    try {
      const step = await prisma.deploymentStep.findUnique({
        where: {
          id: `${deploymentId}-${stepName}`,
        },
      });
      return step?.startedAt.getTime() || Date.now();
    } catch (error) {
      return Date.now();
    }
  }

  /**
   * Update deployment with container IDs
   */
  private async updateDeploymentContainers(
    deploymentId: string,
    newContainerId: string | null,
    oldContainerId: string | null,
  ): Promise<void> {
    try {
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          newContainerId,
          oldContainerId,
        },
      });
    } catch (error) {
      deploymentLogger().error(
        {
          deploymentId,
          newContainerId,
          oldContainerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update deployment containers",
      );
    }
  }

  /**
   * Update deployment health check results
   */
  private async updateDeploymentHealthCheck(
    deploymentId: string,
    passed: boolean,
    logs: any,
  ): Promise<void> {
    try {
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          healthCheckPassed: passed,
          healthCheckLogs: logs,
        },
      });
    } catch (error) {
      deploymentLogger().error(
        {
          deploymentId,
          passed,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update deployment health check",
      );
    }
  }

  /**
   * Find current container for an application
   */
  private async findCurrentContainer(
    applicationName: string,
    color: "blue" | "green",
  ): Promise<string | null> {
    try {
      // Use Docker API to find running container with matching labels
      const containers =
        await this.containerManager["dockerService"].listContainers();

      for (const containerInfo of containers) {
        const labels = containerInfo.labels || {};
        if (
          labels["mini-infra.application"] === applicationName &&
          labels["mini-infra.deployment.color"] === color &&
          labels["mini-infra.deployment.active"] === "true" &&
          containerInfo.status === "running"
        ) {
          return containerInfo.id;
        }
      }

      return null;
    } catch (error) {
      deploymentLogger().warn(
        {
          applicationName,
          color,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to find current container",
      );
      return null;
    }
  }

  /**
   * Update container active status via Docker labels
   */
  private async updateContainerActiveStatus(
    containerId: string,
    active: boolean,
  ): Promise<void> {
    try {
      // This would require updating container labels, which is complex with dockerode
      // For now, we'll log the intent - in a production system this might be handled
      // by restarting containers with updated labels
      deploymentLogger().debug(
        {
          containerId,
          active,
        },
        "Container active status would be updated",
      );
    } catch (error) {
      deploymentLogger().warn(
        {
          containerId,
          active,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update container active status",
      );
    }
  }

  /**
   * Generate active Traefik labels for enabling traffic
   */
  private generateActiveTraefikLabels(
    applicationName: string,
    traefikConfig: TraefikConfig,
    containerConfig: ContainerConfig,
    color: "blue" | "green",
  ): Record<string, string> {
    const routerName = `${traefikConfig.routerName}-${color}`;
    const serviceName = `${traefikConfig.serviceName}-${color}`;

    const labels: Record<string, string> = {
      "traefik.enable": "true",
      [`traefik.http.routers.${routerName}.rule`]: traefikConfig.rule,
      [`traefik.http.routers.${routerName}.service`]: serviceName,
      [`traefik.http.routers.${routerName}.priority`]: "110", // High priority for active container
      "mini-infra.deployment.active": "true",
    };

    // Add TLS if configured
    if (traefikConfig.tls) {
      labels[`traefik.http.routers.${routerName}.tls`] = "true";
    }

    // Add middlewares if configured
    if (traefikConfig.middlewares && traefikConfig.middlewares.length > 0) {
      labels[`traefik.http.routers.${routerName}.middlewares`] =
        traefikConfig.middlewares.join(",");
    }

    // Add service port from first container port
    if (containerConfig.ports.length > 0) {
      labels[`traefik.http.services.${serviceName}.loadbalancer.server.port`] =
        containerConfig.ports[0].containerPort.toString();
    }

    return labels;
  }

  // ====================
  // API Interface Methods
  // ====================

  /**
   * Trigger a new deployment from API
   */
  async triggerDeployment(params: {
    configurationId: string;
    triggerType: DeploymentTriggerType;
    triggeredBy?: string;
    dockerImage: string;
    force?: boolean;
  }): Promise<any> {
    try {
      // Get configuration
      const config = await prisma.deploymentConfiguration.findUnique({
        where: { id: params.configurationId },
      });

      if (!config) {
        throw new Error(
          `Deployment configuration ${params.configurationId} not found`,
        );
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

      // Prepare deployment config
      const deploymentConfig: DeploymentConfig = {
        applicationName: config.applicationName,
        dockerImage: config.dockerImage,
        dockerTag: params.dockerImage.split(":")[1] || "latest",
        containerConfig: config.containerConfig as unknown as ContainerConfig,
        healthCheck: config.healthCheckConfig as unknown as HealthCheckConfig,
        traefikConfig: config.traefikConfig as unknown as TraefikConfig,
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
            "Deployment failed during execution",
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
        "Failed to trigger deployment",
      );
      throw error;
    }
  }

  /**
   * Rollback a deployment from API
   */
  async rollbackDeployment(deploymentId: string): Promise<any> {
    try {
      const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: { configuration: true },
      });

      if (!deployment) {
        throw new Error(`Deployment ${deploymentId} not found`);
      }

      // Update deployment status
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: "rolling_back",
          currentState: "rolling_back",
        },
      });

      // Trigger force rollback
      await this.forceRollback(deploymentId);

      return deployment;
    } catch (error) {
      deploymentLogger().error(
        {
          deploymentId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to rollback deployment",
      );
      throw error;
    }
  }
}

export default DeploymentOrchestrator;
