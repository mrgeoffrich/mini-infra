import { loadbalancerLogger } from "../../../lib/logger-factory";
import { cloudflareDNSService } from "../../cloudflare";

const logger = loadbalancerLogger();

/**
 * RemoveDNS action removes DNS records
 * Deletes CloudFlare DNS A records for the configured hostname
 */
export class RemoveDNS {
  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        applicationName: context?.applicationName,
        hostname: context?.hostname,
      },
      "Action: Removing DNS records..."
    );

    try {
      const hostname = context.hostname;

      if (!hostname) {
        logger.info(
          { applicationName: context?.applicationName },
          "No hostname in context, skipping DNS removal"
        );

        sendEvent({
          type: "DNS_REMOVAL_SKIPPED",
          message: "No hostname configured",
        });
        return;
      }

      logger.info(
        {
          deploymentId: context.deploymentId,
          hostname,
        },
        "Removing CloudFlare DNS record"
      );

      const zone = await cloudflareDNSService.findZoneForHostname(hostname);
      if (!zone) {
        logger.warn({ hostname }, "No Cloudflare zone found for hostname, skipping DNS removal");
        sendEvent({ type: "DNS_REMOVAL_SKIPPED", message: "No Cloudflare zone found" });
        return;
      }

      const record = await cloudflareDNSService.findDNSRecord(zone.id, hostname);
      if (!record) {
        logger.warn({ hostname }, "No DNS record found for hostname, skipping DNS removal");
        sendEvent({ type: "DNS_REMOVAL_SKIPPED", message: "No DNS record found" });
        return;
      }

      await cloudflareDNSService.deleteDNSRecord(zone.id, record.id);

      logger.info(
        {
          deploymentId: context.deploymentId,
          hostname,
        },
        "DNS record removed successfully"
      );

      // Update context
      context.dnsRemoved = true;

      // Send success event
      sendEvent({
        type: "DNS_REMOVED",
        hostname,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during DNS removal";

      logger.error(
        {
          deploymentId: context.deploymentId,
          hostname: context.hostname,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to remove DNS record"
      );

      // Send error event
      sendEvent({
        type: "DNS_REMOVAL_ERROR",
        error: errorMessage,
      });
    }
  }
}
