/**
 * DNS-01 Challenge Provider
 *
 * This service implements DNS-01 challenge for ACME protocol via Cloudflare.
 * It creates and removes TXT records for domain validation.
 */

import { Logger } from "pino";
import NodeCache from "node-cache";
import { getLogger } from "../../lib/logger-factory";
import { CloudflareService } from "../cloudflare";

// Small delay between TXT creation and telling Let's Encrypt to validate.
// LE does its own authoritative lookups from multiple resolvers and retries
// internally, so we don't need to poll — we just give Cloudflare a moment to
// commit the record before the first LE query hits.
const POST_CREATE_DELAY_MS = 5000;

/**
 * Service for handling DNS-01 challenges via Cloudflare
 */
export class DnsChallenge01Provider {
  private cloudflareConfig: CloudflareService;
  private logger: Logger;
  private cache: NodeCache;

  constructor(cloudflareConfig: CloudflareService) {
    this.cloudflareConfig = cloudflareConfig;
    this.logger = getLogger("tls", "dns-challenge-provider");
    // Cache DNS record IDs for 1 hour
    this.cache = new NodeCache({ stdTTL: 3600 });
  }

  /**
   * Create TXT record for ACME challenge
   *
   * @param authz - ACME authorization object
   * @param challenge - ACME challenge object
   * @param keyAuthorization - Key authorization string from ACME
   */
  async createChallenge(authz: { identifier: { value: string } }, challenge: { type: string; token: string }, keyAuthorization: string): Promise<void> {
    if (challenge.type !== "dns-01") {
      throw new Error(`Unsupported challenge type: ${challenge.type}`);
    }

    const domain = authz.identifier.value;
    const recordName = `_acme-challenge.${domain}`;

    this.logger.info({ domain, recordName }, "Creating DNS-01 challenge");

    try {
      // Get Cloudflare zone ID for this domain
      const zoneId = await this.getZoneIdForDomain(domain);

      this.logger.info({ domain, zoneId, recordName }, "Creating TXT record in Cloudflare");

      // Create TXT record via Cloudflare API
      const recordId = await this.cloudflareConfig.createDnsRecord({
        zoneId,
        type: "TXT",
        name: recordName,
        content: keyAuthorization,
        ttl: 120, // 2 minutes
      });

      // Cache record ID for later removal
      const cacheKey = `challenge:${domain}`;
      this.cache.set(cacheKey, recordId);

      this.logger.info(
        { domain, recordName, recordId },
        "DNS-01 challenge TXT record created",
      );

      await new Promise((resolve) => setTimeout(resolve, POST_CREATE_DELAY_MS));

      this.logger.info({ domain, recordName }, "DNS challenge ready for validation");
    } catch (error) {
      this.logger.error(
        {
          domain,
          recordName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to create DNS-01 challenge",
      );
      throw error;
    }
  }

  /**
   * Remove TXT record after validation
   *
   * @param authz - ACME authorization object
   * @param challenge - ACME challenge object
   * @param keyAuthorization - Key authorization string from ACME
   */
  async removeChallenge(authz: { identifier: { value: string } }, _challenge: { type: string; token: string }, _keyAuthorization: string): Promise<void> {
    const domain = authz.identifier.value;
    const recordName = `_acme-challenge.${domain}`;

    this.logger.info({ domain, recordName }, "Removing DNS-01 challenge");

    try {
      // Get cached record ID
      const cacheKey = `challenge:${domain}`;
      const recordId = this.cache.get<string>(cacheKey);

      if (!recordId) {
        this.logger.warn({ domain, recordName }, "No cached record ID for cleanup, skipping");
        return;
      }

      // Get zone ID
      const zoneId = await this.getZoneIdForDomain(domain);

      this.logger.info({ domain, recordName, recordId, zoneId }, "Deleting TXT record from Cloudflare");

      // Delete TXT record via Cloudflare API
      await this.cloudflareConfig.deleteDnsRecord(zoneId, recordId);

      // Remove from cache
      this.cache.del(cacheKey);

      this.logger.info({ domain, recordName, recordId }, "DNS-01 challenge TXT record removed");
    } catch (error) {
      this.logger.error(
        {
          domain,
          recordName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to remove DNS-01 challenge (continuing anyway)",
      );
      // Don't throw - cleanup failures shouldn't fail the certificate issuance
    }
  }

  /**
   * Get Cloudflare zone ID for a domain
   *
   * Handles subdomain extraction to find the base domain.
   *
   * @param domain - Domain name (e.g., "sub.example.com" or "example.com")
   * @returns Cloudflare zone ID
   * @private
   */
  private async getZoneIdForDomain(domain: string): Promise<string> {
    // Try the domain as-is first
    try {
      return await this.cloudflareConfig.getZoneId(domain);
    } catch (error) {
      // If not found, try extracting the base domain
      const parts = domain.split(".");

      // Try removing subdomains until we find a zone
      for (let i = 1; i < parts.length - 1; i++) {
        const baseDomain = parts.slice(i).join(".");
        try {
          this.logger.debug(
            { originalDomain: domain, tryingDomain: baseDomain },
            "Trying to find zone for base domain",
          );

          return await this.cloudflareConfig.getZoneId(baseDomain);
        } catch {
          // Continue trying
        }
      }

      // If we still can't find it, throw the original error
      this.logger.error(
        {
          domain,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not find Cloudflare zone for domain",
      );
      throw error;
    }
  }
}
