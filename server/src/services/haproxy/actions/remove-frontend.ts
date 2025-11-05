import { loadbalancerLogger } from "../../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { haproxyFrontendManager } from "../haproxy-frontend-manager";
import prisma from "../../../lib/prisma";

const logger = loadbalancerLogger();

/**
 * RemoveFrontend action removes an HAProxy frontend for a deployment
 * This action is called during deployment removal to clean up frontend configuration
 */
export class RemoveFrontend {
  private haproxyClient: HAProxyDataPlaneClient;

  constructor() {
    this.haproxyClient = new HAProxyDataPlaneClient();
  }

  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        deploymentConfigId: context?.deploymentConfigId,
        applicationName: context?.applicationName,
      },
      "Action: Removing HAProxy frontend..."
    );

    try {
      // Validate required context
      if (!context.deploymentConfigId) {
        throw new Error(
          "Deployment config ID is required for frontend removal"
        );
      }

      // Get frontend record from database
      const frontendRecord = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId: context.deploymentConfigId },
      });

      if (!frontendRecord) {
        logger.warn(
          { deploymentConfigId: context.deploymentConfigId },
          "No frontend record found in database, skipping removal"
        );

        // Send skipped event
        sendEvent({
          type: "FRONTEND_REMOVAL_SKIPPED",
          message: "No frontend record found",
        });
        return;
      }

      const { frontendName } = frontendRecord;

      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
          frontendRecordId: frontendRecord.id,
        },
        "Found frontend record, proceeding with removal"
      );

      // Check if HAProxy container ID is available
      if (!context.haproxyContainerId) {
        logger.warn(
          { deploymentId: context.deploymentId },
          "HAProxy container ID not available, will try to remove without it"
        );

        // Update database status to removed even if we can't access HAProxy
        await prisma.hAProxyFrontend.update({
          where: { id: frontendRecord.id },
          data: {
            status: "removed",
            errorMessage:
              "HAProxy not accessible, frontend may need manual cleanup",
          },
        });

        sendEvent({
          type: "FRONTEND_REMOVAL_SKIPPED",
          message: "HAProxy not accessible",
        });
        return;
      }

      // Initialize HAProxy DataPlane client
      logger.info(
        {
          deploymentId: context.deploymentId,
          haproxyContainerId: context.haproxyContainerId.slice(0, 12),
          frontendName,
        },
        "Initializing HAProxy DataPlane client for frontend removal"
      );

      await this.haproxyClient.initialize(context.haproxyContainerId);

      // Remove frontend from HAProxy
      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
        },
        "Removing frontend from HAProxy"
      );

      await haproxyFrontendManager.removeFrontend(
        frontendName,
        this.haproxyClient
      );

      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
        },
        "Frontend removed from HAProxy successfully"
      );

      // Update database record status
      await prisma.hAProxyFrontend.update({
        where: { id: frontendRecord.id },
        data: {
          status: "removed",
          errorMessage: null,
        },
      });

      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
          frontendRecordId: frontendRecord.id,
        },
        "Updated frontend record status to 'removed'"
      );

      // Update context
      context.frontendRemoved = true;

      // Send success event
      sendEvent({
        type: "FRONTEND_REMOVED",
        frontendName,
      });

      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
        },
        "Frontend removal completed successfully"
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during frontend removal";

      logger.error(
        {
          deploymentId: context.deploymentId,
          deploymentConfigId: context.deploymentConfigId,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to remove HAProxy frontend"
      );

      // Try to update database with error status
      try {
        const frontendRecord = await prisma.hAProxyFrontend.findUnique({
          where: { deploymentConfigId: context.deploymentConfigId },
        });

        if (frontendRecord) {
          await prisma.hAProxyFrontend.update({
            where: { id: frontendRecord.id },
            data: {
              status: "failed",
              errorMessage,
            },
          });
        }
      } catch (dbError) {
        logger.error(
          { dbError },
          "Failed to update frontend error status in database"
        );
      }

      // Send error event
      sendEvent({
        type: "FRONTEND_REMOVAL_ERROR",
        error: errorMessage,
      });
    }
  }
}
