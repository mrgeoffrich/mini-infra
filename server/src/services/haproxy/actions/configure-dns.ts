import { loadbalancerLogger } from "../../../lib/logger-factory";
import { deploymentDNSManager } from "../../deployment-dns-manager";
import { cloudflareDNSService } from "../../cloudflare";
import { networkUtils } from "../../network-utils";
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
      // Resolve configuration - prefer context fields, fall back to DB lookup
      let hostname: string | undefined;
      let networkType: string | undefined;

      if (context.hostname) {
        // Source-agnostic path: read from context directly
        hostname = context.hostname;
        networkType = context.networkType;
      } else if (context.deploymentConfigId) {
        // Legacy path: look up from database
        if (!context.environmentId) {
          throw new Error("Environment ID is required for DNS configuration");
        }

        const deploymentConfig = await prisma.deploymentConfiguration.findUnique({
          where: { id: context.deploymentConfigId },
          include: { environment: true },
        });

        if (!deploymentConfig) {
          throw new Error(`Deployment configuration not found: ${context.deploymentConfigId}`);
        }

        if (!deploymentConfig.hostname) {
          sendEvent({ type: "DNS_CONFIG_SKIPPED", message: "No hostname configured" });
          return;
        }

        hostname = deploymentConfig.hostname;
        networkType = deploymentConfig.environment.networkType;
      } else {
        // No config available — skip
        sendEvent({ type: "DNS_CONFIG_SKIPPED", message: "No hostname or deployment config available" });
        return;
      }

      logger.info(
        { deploymentId: context.deploymentId, hostname, networkType },
        "Checking network type for DNS configuration"
      );

      // Check network type
      if (networkType === "internet") {
        sendEvent({
          type: "DNS_CONFIG_SKIPPED",
          message: "Network type is 'internet', DNS managed externally",
          networkType,
        });
        context.dnsConfigured = false;
        context.dnsSkipped = true;
        return;
      }

      // For 'local' network type, create DNS record
      if (context.deploymentConfigId && !context.hostname) {
        // Legacy path: use deployment DNS manager
        const dnsRecord = await deploymentDNSManager.createDNSRecordForDeployment(
          context.deploymentConfigId
        );

        if (dnsRecord) {
          context.dnsConfigured = true;
          context.dnsRecordId = dnsRecord.id;
          context.hostname = dnsRecord.hostname;
          sendEvent({ type: "DNS_CONFIGURED", dnsRecordId: dnsRecord.id, hostname: dnsRecord.hostname });
        } else {
          sendEvent({ type: "DNS_CONFIG_SKIPPED", message: "DNS record already exists or was skipped" });
          context.dnsConfigured = false;
          context.dnsSkipped = true;
        }
      } else {
        // Source-agnostic path: create DNS record directly via Cloudflare
        const ip = await networkUtils.getAppropriateIPForEnvironment(context.environmentId);
        await cloudflareDNSService.upsertARecord(hostname!, ip, 300, false);
        context.dnsConfigured = true;
        context.hostname = hostname;
        sendEvent({ type: "DNS_CONFIGURED", hostname });
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

      // Try to update database with error status if DNS record was created (legacy path only)
      if (context.deploymentConfigId) {
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
      }

      // Send error event
      sendEvent({
        type: "DNS_CONFIG_ERROR",
        error: errorMessage,
      });
    }
  }
}
