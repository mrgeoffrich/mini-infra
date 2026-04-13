import type { ActionContext, SendEvent } from './types';
import { loadbalancerLogger } from "../../../lib/logger-factory";
import { cloudflareDNSService } from "../../cloudflare";
import { networkUtils } from "../../network-utils";

const logger = loadbalancerLogger();

/**
 * ConfigureDNS action creates DNS records for deployments
 * Behavior depends on environment networkType:
 * - 'local': Creates CloudFlare DNS record pointing to Docker host
 * - 'internet': Skips DNS creation (assumes external DNS management)
 */
export class ConfigureDNS {
  async execute(context: ActionContext, sendEvent: SendEvent): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        applicationName: context?.applicationName,
        environmentId: context?.environmentId,
        hostname: context?.config?.hostname,
      },
      "Action: Configuring DNS records..."
    );

    try {
      // Resolve configuration from context
      const hostname: string | undefined = context.hostname;
      const networkType: string | undefined = context.networkType;

      if (!hostname) {
        // No hostname configured — skip
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

      // For 'local' network type, create DNS record directly via Cloudflare
      const ip = await networkUtils.getAppropriateIPForEnvironment(context.environmentId);
      await cloudflareDNSService.upsertARecord(hostname, ip, 300, false);
      context.dnsConfigured = true;
      context.hostname = hostname;
      sendEvent({ type: "DNS_CONFIGURED", hostname });

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
          ? (error instanceof Error ? error.message : String(error))
          : "Unknown error during DNS configuration";

      logger.error(
        {
          deploymentId: context.deploymentId,
          applicationName: context.applicationName,
          hostname: context.config?.hostname,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to configure DNS"
      );

      // Send error event
      sendEvent({
        type: "DNS_CONFIG_ERROR",
        error: errorMessage,
      });
    }
  }
}
