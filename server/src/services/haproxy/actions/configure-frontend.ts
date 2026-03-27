import { loadbalancerLogger } from "../../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { haproxyFrontendManager } from "../haproxy-frontend-manager";
import prisma from "../../../lib/prisma";

const logger = loadbalancerLogger();

/**
 * ConfigureFrontend action creates an HAProxy frontend with hostname-based routing
 * This action is called during deployment to set up frontend → backend routing
 */
export class ConfigureFrontend {
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
        environmentId: context?.environmentId,
        hostname: context?.config?.hostname,
      },
      "Action: Configuring HAProxy frontend with hostname routing..."
    );

    try {
      // Validate required context
      if (!context.haproxyContainerId) {
        throw new Error(
          "HAProxy container ID is required for frontend configuration"
        );
      }
      if (!context.applicationName) {
        throw new Error(
          "Application name is required for frontend configuration"
        );
      }
      if (!context.environmentId) {
        throw new Error(
          "Environment ID is required for frontend configuration"
        );
      }
      // Resolve configuration - prefer context fields, fall back to DB lookup
      let hostname: string | undefined;
      let enableSsl: boolean | undefined;
      let tlsCertificateId: string | null | undefined;
      let certificateStatus: string | null | undefined;
      let sourceType: 'stack' | 'manual' | 'deployment' = 'deployment';
      let sourceId: string | undefined = context.deploymentConfigId;

      if (context.hostname) {
        // Source-agnostic path: read from context directly
        hostname = context.hostname;
        enableSsl = context.enableSsl ?? false;
        tlsCertificateId = context.tlsCertificateId;
        certificateStatus = context.certificateStatus;
        sourceType = context.deploymentConfigId ? 'deployment' : 'stack';
        sourceId = context.deploymentConfigId ?? context.deploymentId;
      } else if (context.deploymentConfigId) {
        // Legacy path: look up from database
        const deploymentConfig = await prisma.deploymentConfiguration.findUnique({
          where: { id: context.deploymentConfigId },
          include: { environment: true },
        });

        if (!deploymentConfig) {
          throw new Error(`Deployment configuration not found: ${context.deploymentConfigId}`);
        }

        if (!deploymentConfig.hostname) {
          sendEvent({ type: "FRONTEND_CONFIG_SKIPPED", message: "No hostname configured" });
          return;
        }

        hostname = deploymentConfig.hostname;
        enableSsl = deploymentConfig.enableSsl;
        tlsCertificateId = deploymentConfig.tlsCertificateId;
        certificateStatus = deploymentConfig.certificateStatus;
      } else {
        // No config available — skip
        sendEvent({ type: "FRONTEND_CONFIG_SKIPPED", message: "No hostname configured" });
        return;
      }

      // Initialize HAProxy DataPlane client
      logger.info(
        {
          deploymentId: context.deploymentId,
          haproxyContainerId: context.haproxyContainerId.slice(0, 12),
          hostname,
        },
        "Initializing HAProxy DataPlane client for frontend configuration"
      );

      await this.haproxyClient.initialize(context.haproxyContainerId);

      // Determine backend name (should match what was created in add-container-to-lb)
      const backendName = context.applicationName;

      // Check if backend exists
      const existingBackend =
        await this.haproxyClient.getBackend(backendName);
      if (!existingBackend) {
        throw new Error(
          `Backend not found: ${backendName}. Backend must be created before frontend configuration.`
        );
      }

      logger.info(
        {
          deploymentId: context.deploymentId,
          backendName,
          hostname,
        },
        "Backend exists, proceeding with frontend creation"
      );

      // Check if SSL is enabled and certificate is available
      const hasSslCertificate = Boolean(enableSsl && tlsCertificateId && certificateStatus === "ACTIVE");

      logger.info(
        {
          deploymentId: context.deploymentId,
          enableSsl,
          tlsCertificateId,
          certificateStatus,
          hasSslCertificate,
        },
        "Checking SSL configuration for frontend"
      );

      // Get or create shared frontend for this environment
      const frontendType = hasSslCertificate ? "https" : "http";
      const sharedFrontend = await haproxyFrontendManager.getOrCreateSharedFrontend(
        context.environmentId,
        frontendType,
        this.haproxyClient,
        prisma,
        {
          tlsCertificateId: hasSslCertificate ? (tlsCertificateId ?? undefined) : undefined,
        }
      );

      logger.info(
        {
          deploymentId: context.deploymentId,
          sharedFrontendId: sharedFrontend.id,
          sharedFrontendName: sharedFrontend.frontendName,
          frontendType,
        },
        "Shared frontend retrieved/created"
      );

      // Add route to shared frontend
      const route = await haproxyFrontendManager.addRouteToSharedFrontend(
        sharedFrontend.id,
        hostname!,
        backendName,
        sourceType,
        sourceId!,
        this.haproxyClient,
        prisma,
        {
          useSSL: hasSslCertificate,
          tlsCertificateId: hasSslCertificate ? (tlsCertificateId ?? undefined) : undefined,
        }
      );

      const frontendName = sharedFrontend.frontendName;

      logger.info(
        {
          deploymentId: context.deploymentId,
          routeId: route.id,
          frontendName,
          hostname,
          backendName,
          hasSslCertificate,
        },
        "Route added to shared frontend successfully"
      );

      // Check if a manual frontend record exists for this deployment config
      // If so, mark it as removed since we're now using shared frontends
      // (Only applies to legacy deployments with deploymentConfigId)
      if (context.deploymentConfigId) {
        const existingFrontend = await prisma.hAProxyFrontend.findUnique({
          where: { deploymentConfigId: context.deploymentConfigId },
        });

        if (existingFrontend && !existingFrontend.isSharedFrontend) {
          await prisma.hAProxyFrontend.update({
            where: { id: existingFrontend.id },
            data: {
              status: "removed",
              errorMessage: "Migrated to shared frontend architecture",
            },
          });

          logger.info(
            {
              deploymentId: context.deploymentId,
              frontendId: existingFrontend.id,
            },
            "Marked manual frontend record as removed"
          );
        }
      }

      // Update context with frontend information
      context.frontendConfigured = true;
      context.frontendName = frontendName;

      // Send success event
      sendEvent({
        type: "FRONTEND_CONFIGURED",
        frontendName,
        hostname,
        backendName,
      });

      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
          hostname,
          backendName,
        },
        "Frontend configuration completed successfully"
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during frontend configuration";

      logger.error(
        {
          deploymentId: context.deploymentId,
          deploymentConfigId: context.deploymentConfigId,
          applicationName: context.applicationName,
          hostname: context.config?.hostname,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to configure HAProxy frontend"
      );

      // Update database with error status if record exists (legacy path only)
      if (context.deploymentConfigId) {
        try {
          const existingFrontend = await prisma.hAProxyFrontend.findUnique({
            where: { deploymentConfigId: context.deploymentConfigId },
          });

          if (existingFrontend) {
            await prisma.hAProxyFrontend.update({
              where: { id: existingFrontend.id },
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
      }

      // Send error event
      sendEvent({
        type: "FRONTEND_CONFIG_ERROR",
        error: errorMessage,
      });
    }
  }
}
