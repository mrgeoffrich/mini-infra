import { PrismaClient } from "../../lib/prisma";
import { servicesLogger } from "../../lib/logger-factory";
import DockerService from "../docker";
import { ContainerLifecycleManager } from "../container";
import { DeploymentOrchestrator } from "../deployment-orchestrator";

export class ConfigDeletionManager {
  private prisma: PrismaClient;
  private dockerService: DockerService;
  private containerManager: ContainerLifecycleManager;
  private deploymentOrchestrator: DeploymentOrchestrator;
  private clearCacheFn: () => void;

  constructor(
    prisma: PrismaClient,
    dockerService: DockerService,
    containerManager: ContainerLifecycleManager,
    deploymentOrchestrator: DeploymentOrchestrator,
    clearCacheFn: () => void,
  ) {
    this.prisma = prisma;
    this.dockerService = dockerService;
    this.containerManager = containerManager;
    this.deploymentOrchestrator = deploymentOrchestrator;
    this.clearCacheFn = clearCacheFn;
  }

  /**
   * Delete a deployment configuration using removal state machine
   */
  async deleteDeploymentConfig(
    configId: string,
    triggeredBy?: string,
  ): Promise<{ removalId: string }> {
    try {
      // Verify existence
      const config = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          id: configId,
        },
      });

      if (!config) {
        throw new Error("Deployment configuration not found");
      }

      const logger = servicesLogger();
      const applicationName = config.applicationName;

      logger.info(
        {
          configId: configId,
          applicationName,
        },
        "Starting deployment configuration deletion with removal state machine",
      );

      // Execute removal state machine
      let removalId: string;
      try {
        removalId = await this.deploymentOrchestrator.executeRemovalStateMachine({
          configurationId: configId,
          applicationName: applicationName,
          triggeredBy: triggeredBy,
        });

        logger.info(
          {
            configId: configId,
            applicationName,
            removalId,
          },
          "Removal state machine started successfully",
        );
      } catch (stateMachineError) {
        logger.warn(
          {
            configId: configId,
            applicationName,
            error: stateMachineError instanceof Error ? stateMachineError.message : "Unknown state machine error",
          },
          "Failed to start removal state machine - falling back to direct cleanup",
        );

        // Fallback to direct cleanup if state machine fails
        try {
          await this.cleanupApplicationContainers(applicationName);
          logger.info(
            {
              configId: configId,
              applicationName,
            },
            "Successfully cleaned up application containers using fallback method",
          );
        } catch (cleanupError) {
          logger.warn(
            {
              configId: configId,
              applicationName,
              error: cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup error",
            },
            "Failed to cleanup containers during deletion - continuing with database deletion",
          );
        }

        // Delete configuration immediately on fallback
        await this.prisma.deploymentConfiguration.delete({
          where: { id: configId },
        });

        // Clear cache
        this.clearCacheFn();

        logger.info(
          {
            configId: configId,
            applicationName,
          },
          "Deployment configuration deleted successfully using fallback",
        );

        // Return a fallback removalId
        return { removalId: `fallback-${configId}-${Date.now()}` };
      }

      // Set up a background process to delete the configuration after state machine completion
      this.scheduleConfigurationDeletion(configId, removalId, applicationName);

      return { removalId };
    } catch (error) {
      servicesLogger().error(
        {
          configId: configId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to delete deployment configuration",
      );
      throw error;
    }
  }

  /**
   * Schedule configuration deletion after successful removal state machine completion
   */
  private async scheduleConfigurationDeletion(
    configId: string,
    removalId: string,
    applicationName: string,
  ): Promise<void> {
    const logger = servicesLogger();

    // Poll for state machine completion (in a real implementation, you might use events or queues)
    const pollInterval = setInterval(async () => {
      try {
        const status = this.deploymentOrchestrator.getRemovalOperationStatus(removalId);

        if (!status.isActive) {
          clearInterval(pollInterval);

          if (status.currentState === "completed") {
            // State machine completed successfully, delete the configuration
            try {
              await this.prisma.deploymentConfiguration.delete({
                where: { id: configId },
              });

              // Clear cache
              this.clearCacheFn();

              logger.info(
                {
                  configId,
                  applicationName,
                  removalId,
                },
                "Deployment configuration deleted after successful removal state machine completion",
              );
            } catch (deleteError) {
              logger.error(
                {
                  configId,
                  applicationName,
                  removalId,
                  error: deleteError instanceof Error ? deleteError.message : "Unknown delete error",
                },
                "Failed to delete deployment configuration after successful removal",
              );
            }
          } else {
            // State machine failed, log warning but don't delete configuration
            logger.warn(
              {
                configId,
                applicationName,
                removalId,
                finalState: status.currentState,
                error: status.context?.error,
              },
              "Removal state machine failed - configuration not deleted, manual cleanup may be required",
            );
          }
        }
      } catch (error) {
        logger.error(
          {
            configId,
            removalId,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Error while polling for removal state machine completion",
        );
      }
    }, 5000); // Poll every 5 seconds

    // Set a maximum timeout to avoid infinite polling
    setTimeout(() => {
      clearInterval(pollInterval);
      logger.warn(
        {
          configId,
          applicationName,
          removalId,
        },
        "Stopped polling for removal state machine completion due to timeout",
      );
    }, 300000); // 5 minutes timeout
  }

  /**
   * Clean up all containers for a given application
   */
  private async cleanupApplicationContainers(applicationName: string): Promise<void> {
    const logger = servicesLogger();

    try {
      // Find all containers with the application label
      const containers = await this.dockerService.listContainers();
      const appContainers = containers.filter((container: any) => {
        const labels = container.labels || {};
        return labels["mini-infra.application"] === applicationName;
      });

      if (appContainers.length === 0) {
        logger.info(
          { applicationName },
          "No containers found for application - skipping cleanup",
        );
        return;
      }

      logger.info(
        {
          applicationName,
          containerCount: appContainers.length,
          containerIds: appContainers.map((c: any) => c.id.slice(0, 12)),
        },
        "Found containers to clean up for application",
      );

      // Stop and remove each container
      for (const container of appContainers) {
        const containerId = container.id;
        const containerName = container.name || containerId;

        try {
          logger.info(
            { applicationName, containerId: containerId.slice(0, 12), containerName },
            "Stopping and removing container",
          );

          // Stop the container with a 30 second timeout
          await this.containerManager.stopContainer(containerId, 30);

          // Remove the container (force=true to handle any remaining processes)
          await this.containerManager.removeContainer(containerId, true);

          logger.info(
            { applicationName, containerId: containerId.slice(0, 12), containerName },
            "Successfully cleaned up container",
          );
        } catch (containerError) {
          logger.warn(
            {
              applicationName,
              containerId: containerId.slice(0, 12),
              containerName,
              error: containerError instanceof Error ? containerError.message : "Unknown error",
            },
            "Failed to cleanup individual container - continuing with others",
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          applicationName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to cleanup application containers",
      );
      throw error;
    }
  }
}
