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
      if (!context.deploymentConfigId) {
        throw new Error(
          "Deployment config ID is required for frontend configuration"
        );
      }

      // Get deployment configuration
      const deploymentConfig = await prisma.deploymentConfiguration.findUnique(
        {
          where: { id: context.deploymentConfigId },
          include: { environment: true },
        }
      );

      if (!deploymentConfig) {
        throw new Error(
          `Deployment configuration not found: ${context.deploymentConfigId}`
        );
      }

      // Check if hostname is configured
      if (!deploymentConfig.hostname) {
        logger.warn(
          { deploymentConfigId: context.deploymentConfigId },
          "No hostname configured for deployment, skipping frontend configuration"
        );

        // Send skipped event
        sendEvent({
          type: "FRONTEND_CONFIG_SKIPPED",
          message: "No hostname configured",
        });
        return;
      }

      const { hostname } = deploymentConfig;

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
      const enableSsl = deploymentConfig.enableSsl;
      const tlsCertificateId = deploymentConfig.tlsCertificateId;
      const hasSslCertificate = Boolean(enableSsl && tlsCertificateId && deploymentConfig.certificateStatus === "ACTIVE");

      logger.info(
        {
          deploymentId: context.deploymentId,
          enableSsl,
          tlsCertificateId,
          certificateStatus: deploymentConfig.certificateStatus,
          hasSslCertificate,
        },
        "Checking SSL configuration for frontend"
      );

      // Create or update HAProxy frontend
      const frontendName = await haproxyFrontendManager.createFrontendForDeployment(
        hostname,
        backendName,
        context.applicationName,
        context.environmentId,
        this.haproxyClient,
        hasSslCertificate ? {
          tlsCertificateId: tlsCertificateId || undefined,
          prisma,
        } : undefined
      );

      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
          hostname,
          backendName,
          hasSslCertificate,
        },
        "HAProxy frontend created successfully"
      );

      // Check if frontend record already exists in database
      const existingFrontend = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId: context.deploymentConfigId },
      });

      if (existingFrontend) {
        // Update existing record
        await prisma.hAProxyFrontend.update({
          where: { id: existingFrontend.id },
          data: {
            frontendName,
            backendName,
            hostname,
            useSSL: hasSslCertificate,
            tlsCertificateId: hasSslCertificate ? tlsCertificateId : null,
            sslBindPort: hasSslCertificate ? 443 : 443,
            status: "active",
            errorMessage: null,
          },
        });

        logger.info(
          {
            deploymentId: context.deploymentId,
            frontendId: existingFrontend.id,
            hasSslCertificate,
          },
          "Updated existing frontend record in database"
        );
      } else {
        // Create new frontend record in database
        await prisma.hAProxyFrontend.create({
          data: {
            deploymentConfigId: context.deploymentConfigId,
            frontendName,
            backendName,
            hostname,
            bindPort: 80,
            bindAddress: "*",
            useSSL: hasSslCertificate,
            tlsCertificateId: hasSslCertificate ? tlsCertificateId : null,
            sslBindPort: hasSslCertificate ? 443 : 443,
            status: "active",
          },
        });

        logger.info(
          {
            deploymentId: context.deploymentId,
            frontendName,
            hasSslCertificate,
          },
          "Created frontend record in database"
        );
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

      // Update database with error status if record exists
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

      // Send error event
      sendEvent({
        type: "FRONTEND_CONFIG_ERROR",
        error: errorMessage,
      });
    }
  }
}
