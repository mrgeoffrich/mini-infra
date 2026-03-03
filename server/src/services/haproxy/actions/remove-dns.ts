import { loadbalancerLogger } from "../../../lib/logger-factory";
import { deploymentDNSManager } from "../../deployment-dns-manager";
import prisma from "../../../lib/prisma";

const logger = loadbalancerLogger();

/**
 * RemoveDNS action removes DNS records for deployments
 * Deletes CloudFlare DNS records for 'local' network type deployments
 * Skips for 'internet' network type (external DNS assumed)
 */
export class RemoveDNS {
  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        deploymentConfigId: context?.deploymentConfigId,
        applicationName: context?.applicationName,
      },
      "Action: Removing DNS records for deployment..."
    );

    try {
      // Validate required context
      if (!context.deploymentConfigId) {
        throw new Error(
          "Deployment config ID is required for DNS removal"
        );
      }

      // Get DNS record from database
      const dnsRecord = await prisma.deploymentDNSRecord.findFirst({
        where: {
          deploymentConfigId: context.deploymentConfigId,
          status: { not: "removed" },
        },
      });

      if (!dnsRecord) {
        logger.warn(
          { deploymentConfigId: context.deploymentConfigId },
          "No active DNS record found for deployment, skipping removal"
        );

        // Send skipped event
        sendEvent({
          type: "DNS_REMOVAL_SKIPPED",
          message: "No active DNS record found",
        });
        return;
      }

      logger.info(
        {
          deploymentId: context.deploymentId,
          dnsRecordId: dnsRecord.id,
          hostname: dnsRecord.hostname,
          dnsProvider: dnsRecord.dnsProvider,
        },
        "Found DNS record, proceeding with removal"
      );

      // Check DNS provider
      if (dnsRecord.dnsProvider === "external") {
        logger.info(
          {
            deploymentId: context.deploymentId,
            dnsRecordId: dnsRecord.id,
          },
          "DNS provider is external, skipping CloudFlare removal"
        );

        // Update database status
        await prisma.deploymentDNSRecord.update({
          where: { id: dnsRecord.id },
          data: { status: "removed" },
        });

        sendEvent({
          type: "DNS_REMOVAL_SKIPPED",
          message: "DNS provider is external",
        });
        return;
      }

      // For CloudFlare DNS, remove the record
      logger.info(
        {
          deploymentId: context.deploymentId,
          dnsRecordId: dnsRecord.id,
          hostname: dnsRecord.hostname,
        },
        "Removing CloudFlare DNS record"
      );

      await deploymentDNSManager.removeDNSRecordForDeployment(
        context.deploymentConfigId
      );

      logger.info(
        {
          deploymentId: context.deploymentId,
          dnsRecordId: dnsRecord.id,
          hostname: dnsRecord.hostname,
        },
        "DNS record removed successfully"
      );

      // Update context
      context.dnsRemoved = true;

      // Send success event
      sendEvent({
        type: "DNS_REMOVED",
        dnsRecordId: dnsRecord.id,
        hostname: dnsRecord.hostname,
      });

      logger.info(
        {
          deploymentId: context.deploymentId,
          dnsRecordId: dnsRecord.id,
        },
        "DNS removal completed successfully"
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during DNS removal";

      logger.error(
        {
          deploymentId: context.deploymentId,
          deploymentConfigId: context.deploymentConfigId,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to remove DNS record"
      );

      // Try to update database with error status
      try {
        const dnsRecord = await prisma.deploymentDNSRecord.findFirst({
          where: {
            deploymentConfigId: context.deploymentConfigId,
            status: { not: "removed" },
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
        type: "DNS_REMOVAL_ERROR",
        error: errorMessage,
      });
    }
  }
}
