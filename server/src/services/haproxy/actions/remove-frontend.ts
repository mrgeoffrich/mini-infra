import { loadbalancerLogger } from "../../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { haproxyFrontendManager } from "../haproxy-frontend-manager";
import prisma from "../../../lib/prisma";

const logger = loadbalancerLogger();

/**
 * RemoveFrontend action removes HAProxy frontend configuration for a deployment
 * This action handles both:
 * - Manual frontends (per-deployment HAProxyFrontend records)
 * - Shared frontend routes (HAProxyRoute records pointing to shared frontends)
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
      "Action: Removing HAProxy frontend configuration..."
    );

    try {
      // Validate required context
      if (!context.deploymentConfigId) {
        throw new Error(
          "Deployment config ID is required for frontend removal"
        );
      }

      // Check if HAProxy container ID is available
      if (!context.haproxyContainerId) {
        logger.warn(
          { deploymentId: context.deploymentId },
          "HAProxy container ID not available, will update database only"
        );

        // Update database records even if we can't access HAProxy
        await this.updateDatabaseRecordsOnSkip(context.deploymentConfigId);

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
        },
        "Initializing HAProxy DataPlane client for frontend removal"
      );

      await this.haproxyClient.initialize(context.haproxyContainerId);

      // Track what we removed
      let routeRemoved = false;
      let manualFrontendRemoved = false;

      // Step 1: Check for HAProxyRoute (shared frontend architecture)
      const routeRecord = await prisma.hAProxyRoute.findFirst({
        where: { deploymentConfigId: context.deploymentConfigId },
        include: { sharedFrontend: true },
      });

      if (routeRecord) {
        logger.info(
          {
            deploymentId: context.deploymentId,
            routeId: routeRecord.id,
            hostname: routeRecord.hostname,
            sharedFrontendId: routeRecord.sharedFrontendId,
            sharedFrontendName: routeRecord.sharedFrontend.frontendName,
          },
          "Found route in shared frontend, removing route only"
        );

        // Remove only the route from the shared frontend (not the frontend itself)
        await haproxyFrontendManager.removeRouteFromSharedFrontend(
          routeRecord.sharedFrontendId,
          routeRecord.hostname,
          this.haproxyClient,
          prisma
        );

        routeRemoved = true;

        logger.info(
          {
            deploymentId: context.deploymentId,
            hostname: routeRecord.hostname,
            sharedFrontendName: routeRecord.sharedFrontend.frontendName,
          },
          "Route removed from shared frontend successfully"
        );

        // Clean up certificate if route had SSL enabled
        if (routeRecord.tlsCertificateId) {
          logger.info(
            {
              deploymentId: context.deploymentId,
              tlsCertificateId: routeRecord.tlsCertificateId,
            },
            "Cleaning up SSL certificate after route removal"
          );

          try {
            await haproxyFrontendManager.removeCertificateFromHAProxy(
              routeRecord.tlsCertificateId,
              prisma,
              this.haproxyClient
            );
          } catch (certError) {
            // Log warning but don't fail the removal if certificate cleanup fails
            logger.warn(
              {
                deploymentId: context.deploymentId,
                tlsCertificateId: routeRecord.tlsCertificateId,
                error: certError instanceof Error ? certError.message : "Unknown error",
              },
              "Failed to remove SSL certificate (non-critical)"
            );
          }
        }
      }

      // Step 2: Check for manual HAProxyFrontend record
      const frontendRecord = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId: context.deploymentConfigId },
      });

      if (frontendRecord) {
        // Only remove if it's NOT a shared frontend
        if (frontendRecord.isSharedFrontend) {
          logger.warn(
            {
              deploymentId: context.deploymentId,
              frontendRecordId: frontendRecord.id,
              frontendName: frontendRecord.frontendName,
            },
            "Frontend record is a shared frontend, skipping frontend deletion (routes should be removed instead)"
          );
        } else {
          logger.info(
            {
              deploymentId: context.deploymentId,
              frontendName: frontendRecord.frontendName,
              frontendRecordId: frontendRecord.id,
            },
            "Found manual frontend record, proceeding with removal"
          );

          // Remove manual frontend from HAProxy
          await haproxyFrontendManager.removeFrontend(
            frontendRecord.frontendName,
            this.haproxyClient
          );

          manualFrontendRemoved = true;

          logger.info(
            {
              deploymentId: context.deploymentId,
              frontendName: frontendRecord.frontendName,
            },
            "Manual frontend removed from HAProxy successfully"
          );

          // Update database record status
          await prisma.hAProxyFrontend.update({
            where: { id: frontendRecord.id },
            data: {
              status: "removed",
              errorMessage: null,
            },
          });

          // Clean up certificate if manual frontend had SSL enabled
          if (frontendRecord.tlsCertificateId) {
            logger.info(
              {
                deploymentId: context.deploymentId,
                tlsCertificateId: frontendRecord.tlsCertificateId,
              },
              "Cleaning up SSL certificate after manual frontend removal"
            );

            try {
              await haproxyFrontendManager.removeCertificateFromHAProxy(
                frontendRecord.tlsCertificateId,
                prisma,
                this.haproxyClient
              );
            } catch (certError) {
              // Log warning but don't fail the removal if certificate cleanup fails
              logger.warn(
                {
                  deploymentId: context.deploymentId,
                  tlsCertificateId: frontendRecord.tlsCertificateId,
                  error: certError instanceof Error ? certError.message : "Unknown error",
                },
                "Failed to remove SSL certificate (non-critical)"
              );
            }
          }
        }
      }

      // Step 3: Remove backend if no other routes/frontends are using it
      const backendName = context.applicationName;
      if (backendName) {
        await this.removeBackendIfOrphaned(context.deploymentId, backendName, context.deploymentConfigId);
      }

      // Determine result
      if (!routeRemoved && !manualFrontendRemoved && !frontendRecord) {
        logger.warn(
          { deploymentConfigId: context.deploymentConfigId },
          "No frontend or route records found in database, skipping removal"
        );

        sendEvent({
          type: "FRONTEND_REMOVAL_SKIPPED",
          message: "No frontend or route records found",
        });
        return;
      }

      // Update context
      context.frontendRemoved = true;

      // Send success event
      sendEvent({
        type: "FRONTEND_REMOVED",
        frontendName: frontendRecord?.frontendName || routeRecord?.sharedFrontend.frontendName,
      });

      logger.info(
        {
          deploymentId: context.deploymentId,
          routeRemoved,
          manualFrontendRemoved,
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

  /**
   * Update database records when HAProxy is not accessible
   */
  private async updateDatabaseRecordsOnSkip(deploymentConfigId: string): Promise<void> {
    // Update route status if exists
    const routeRecord = await prisma.hAProxyRoute.findFirst({
      where: { deploymentConfigId },
    });

    if (routeRecord) {
      await prisma.hAProxyRoute.update({
        where: { id: routeRecord.id },
        data: { status: "removed" },
      });
    }

    // Update frontend status if exists
    const frontendRecord = await prisma.hAProxyFrontend.findUnique({
      where: { deploymentConfigId },
    });

    if (frontendRecord) {
      await prisma.hAProxyFrontend.update({
        where: { id: frontendRecord.id },
        data: {
          status: "removed",
          errorMessage: "HAProxy not accessible, frontend may need manual cleanup",
        },
      });
    }
  }

  /**
   * Remove backend only if no other routes or frontends are using it
   */
  private async removeBackendIfOrphaned(deploymentId: string, backendName: string, deploymentConfigId: string): Promise<void> {
    try {
      // Check if any other routes are using this backend
      const otherRoutes = await prisma.hAProxyRoute.findFirst({
        where: {
          backendName,
          status: "active",
        },
      });

      if (otherRoutes) {
        logger.info(
          {
            deploymentId,
            backendName,
            otherRouteId: otherRoutes.id,
          },
          "Backend is still in use by other routes, skipping backend removal"
        );
        return;
      }

      // Check if any other frontends are using this backend
      const otherFrontends = await prisma.hAProxyFrontend.findFirst({
        where: {
          backendName,
          status: "active",
        },
      });

      if (otherFrontends) {
        logger.info(
          {
            deploymentId,
            backendName,
            otherFrontendId: otherFrontends.id,
          },
          "Backend is still in use by other frontends, skipping backend removal"
        );
        return;
      }

      // Backend is orphaned, remove it
      const existingBackend = await this.haproxyClient.getBackend(backendName);
      if (existingBackend) {
        logger.info(
          {
            deploymentId,
            backendName,
          },
          "Removing orphaned HAProxy backend"
        );

        await this.haproxyClient.deleteBackend(backendName);

        // Mark backend as removed in database
        try {
          // Find the environment from the deployment config
          const deploymentConfig = await prisma.deploymentConfiguration.findUnique({
            where: { id: deploymentConfigId },
            select: { environmentId: true },
          });

          if (deploymentConfig?.environmentId) {
            await prisma.hAProxyBackend.updateMany({
              where: {
                name: backendName,
                environmentId: deploymentConfig.environmentId,
              },
              data: {
                status: 'removed',
              },
            });
            logger.info({ backendName }, 'Backend marked as removed in database');
          }
        } catch (dbError) {
          logger.warn(
            {
              backendName,
              error: dbError instanceof Error ? dbError.message : 'Unknown error',
            },
            'Failed to mark backend as removed in database (non-critical)'
          );
        }

        logger.info(
          {
            deploymentId,
            backendName,
          },
          "HAProxy backend removed successfully"
        );
      } else {
        logger.info(
          {
            deploymentId,
            backendName,
          },
          "Backend does not exist in HAProxy, skipping backend removal"
        );
      }
    } catch (backendError) {
      // Log warning but don't fail the removal if backend cleanup fails
      logger.warn(
        {
          deploymentId,
          backendName,
          error: backendError instanceof Error ? backendError.message : "Unknown error",
        },
        "Failed to remove backend (non-critical)"
      );
    }
  }
}
