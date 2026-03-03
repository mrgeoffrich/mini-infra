import { loadbalancerLogger } from "../../../lib/logger-factory";
import { deploymentDNSManager } from "../../deployment-dns-manager";
import prisma from "../../../lib/prisma";

const logger = loadbalancerLogger();

/**
 * ConfigureDNS action creates DNS records for deployments
 * Behavior depends on environment networkType:
 * - 'local': Creates CloudFlare DNS record pointing to Docker host
 * - 'internet': Skips DNS creation (assumes external DNS management)
 */
export class ConfigureDNS {
  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        deploymentConfigId: context?.deploymentConfigId,
        applicationName: context?.applicationName,
        environmentId: context?.environmentId,
        hostname: context?.config?.hostname,
      },
      "Action: Configuring DNS records for deployment..."
    );

    try {
      // Validate required context
      if (!context.deploymentConfigId) {
        throw new Error(
          "Deployment config ID is required for DNS configuration"
        );
      }
      if (!context.environmentId) {
        throw new Error(
          "Environment ID is required for DNS configuration"
        );
      }

      // Get deployment configuration with environment
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
          "No hostname configured for deployment, skipping DNS configuration"
        );

        // Send skipped event
        sendEvent({
          type: "DNS_CONFIG_SKIPPED",
          message: "No hostname configured",
        });
        return;
      }

      const { hostname, environment } = deploymentConfig;
      const networkType = environment.networkType;

      logger.info(
        {
          deploymentId: context.deploymentId,
          hostname,
          networkType,
        },
        "Checking network type for DNS configuration"
      );

      // Check network type
      if (networkType === "internet") {
        logger.info(
          {
            deploymentId: context.deploymentId,
            hostname,
            networkType,
          },
          "Network type is 'internet', skipping DNS creation (external DNS assumed)"
        );

        // Send skipped event
        sendEvent({
          type: "DNS_CONFIG_SKIPPED",
          message:
            "Network type is 'internet', DNS managed externally",
          networkType,
        });

        // Update context
        context.dnsConfigured = false;
        context.dnsSkipped = true;

        return;
      }

      // For 'local' network type, create DNS record
      logger.info(
        {
          deploymentId: context.deploymentId,
          hostname,
          networkType,
        },
        "Network type is 'local', creating DNS record in CloudFlare"
      );

      // Create DNS record using deployment DNS manager
      const dnsRecord =
        await deploymentDNSManager.createDNSRecordForDeployment(
          context.deploymentConfigId
        );

      if (dnsRecord) {
        logger.info(
          {
            deploymentId: context.deploymentId,
            dnsRecordId: dnsRecord.id,
            hostname: dnsRecord.hostname,
          },
          "DNS record created successfully"
        );

        // Update context
        context.dnsConfigured = true;
        context.dnsRecordId = dnsRecord.id;
        context.hostname = dnsRecord.hostname;

        // Send success event
        sendEvent({
          type: "DNS_CONFIGURED",
          dnsRecordId: dnsRecord.id,
          hostname: dnsRecord.hostname,
        });
      } else {
        // DNS was skipped (might be external or already exists)
        logger.info(
          {
            deploymentId: context.deploymentId,
            hostname,
          },
          "DNS record creation returned null, marking as skipped"
        );

        sendEvent({
          type: "DNS_CONFIG_SKIPPED",
          message: "DNS record already exists or was skipped",
          hostname,
        });

        context.dnsConfigured = false;
        context.dnsSkipped = true;
      }

      logger.info(
        {
          deploymentId: context.deploymentId,
          hostname,
          dnsConfigured: context.dnsConfigured,
        },
        "DNS configuration completed"
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during DNS configuration";

      logger.error(
        {
          deploymentId: context.deploymentId,
          deploymentConfigId: context.deploymentConfigId,
          applicationName: context.applicationName,
          hostname: context.config?.hostname,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to configure DNS"
      );

      // Try to update database with error status if DNS record was created
      try {
        const dnsRecord = await prisma.deploymentDNSRecord.findFirst({
          where: {
            deploymentConfigId: context.deploymentConfigId,
            status: "pending",
          },
        });

        if (dnsRecord) {
          await prisma.deploymentDNSRecord.update({
            where: { id: dnsRecord.id },
            data: {
              status: "failed",
              errorMessage,
            },
          });
        }
      } catch (dbError) {
        logger.error(
          { dbError },
          "Failed to update DNS error status in database"
        );
      }

      // Send error event
      sendEvent({
        type: "DNS_CONFIG_ERROR",
        error: errorMessage,
      });
    }
  }
}
