import type { Zone } from "cloudflare/resources/zones/zones.js";
import type {
  RecordResponse,
  RecordCreateParams,
  RecordListParams,
  RecordUpdateParams,
} from "cloudflare/resources/dns/records.js";
import { servicesLogger } from "../../lib/logger-factory";
import { CloudflareService } from "./cloudflare-service";
import {
  CloudflareApiRunner,
  CLOUDFLARE_TIMEOUT_MS,
} from "./cloudflare-api-runner";
import prisma from "../../lib/prisma";
import {
  CloudflareDNSZone,
  CloudflareDNSRecord,
  CreateCloudflareDNSRecordRequest,
  UpdateCloudflareDNSRecordRequest,
} from "@mini-infra/types";

const logger = servicesLogger();

/**
 * Extends the SDK RecordResponse with fields the API returns at runtime
 * but the SDK's TypeScript types omit (zone_id, zone_name, locked, data).
 */
type SdkRecord = RecordResponse & {
  zone_id?: string;
  zone_name?: string;
  locked?: boolean;
  data?: Record<string, unknown>;
};

function toDnsRecord(
  raw: RecordResponse,
  fallbackZoneId: string,
): CloudflareDNSRecord {
  const record = raw as SdkRecord;
  return {
    id: record.id,
    type: record.type,
    name: record.name ?? "",
    content: record.content ?? "",
    proxiable: record.proxiable ?? true,
    proxied: record.proxied ?? false,
    ttl: record.ttl,
    locked: record.locked ?? false,
    zone_id: record.zone_id ?? fallbackZoneId,
    zone_name: record.zone_name ?? "",
    created_on: record.created_on,
    modified_on: record.modified_on,
    data: record.data,
    meta: record.meta as CloudflareDNSRecord["meta"],
  };
}

function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("not found") ||
    (error as { status?: number })?.status === 404
  );
}

/**
 * Zone/record management for Cloudflare DNS. Shares the
 * {@link CloudflareApiRunner} owned by {@link CloudflareService} so
 * circuit-breaker state, auth, timeouts and logging stay unified across
 * every outbound Cloudflare call.
 */
export class CloudflareDNSService {
  private readonly cloudflareConfigService: CloudflareService;
  private readonly runner: CloudflareApiRunner;

  constructor(cloudflareConfigService?: CloudflareService) {
    this.cloudflareConfigService =
      cloudflareConfigService ?? new CloudflareService(prisma);
    this.runner = this.cloudflareConfigService.runner;
  }

  async listZones(): Promise<CloudflareDNSZone[]> {
    logger.info("Listing Cloudflare DNS zones");

    try {
      const { cf } = await this.runner.getAuthorizedClient({
        requireAccountId: false,
      });
      const response = await this.runner.withTimeout(
        cf.zones.list(),
        "zones list",
        CLOUDFLARE_TIMEOUT_MS,
      );

      const zones = response.result.map((zone: Zone) => ({
        id: zone.id,
        name: zone.name,
        status: (zone.status ?? "active") as CloudflareDNSZone["status"],
        paused: zone.paused ?? false,
        type: (zone.type ?? "full") as CloudflareDNSZone["type"],
        development_mode: zone.development_mode,
        name_servers: zone.name_servers || [],
        original_name_servers: zone.original_name_servers ?? undefined,
        original_registrar: zone.original_registrar ?? undefined,
        original_dnshost: zone.original_dnshost ?? undefined,
        created_on: zone.created_on,
        modified_on: zone.modified_on,
      }));

      logger.info({ zoneCount: zones.length }, "Retrieved Cloudflare DNS zones");
      return zones;
    } catch (error) {
      logger.error({ error }, "Failed to list Cloudflare DNS zones");
      throw new Error(`Failed to list DNS zones: ${error}`, { cause: error });
    }
  }

  /**
   * Find the zone that owns a given hostname. Example:
   * `api.example.com` → the `example.com` zone.
   */
  async findZoneForHostname(
    hostname: string,
  ): Promise<CloudflareDNSZone | null> {
    logger.info({ hostname }, "Finding zone for hostname");

    try {
      const zones = await this.listZones();
      const parts = hostname.toLowerCase().split(".");

      // Most-specific to least-specific match (api.example.com → example.com → com).
      for (let i = 0; i < parts.length - 1; i++) {
        const candidateZone = parts.slice(i).join(".");
        const match = zones.find(
          (zone) => zone.name.toLowerCase() === candidateZone,
        );
        if (match) {
          logger.info(
            { hostname, zoneName: match.name, zoneId: match.id },
            "Found matching zone for hostname",
          );
          return match;
        }
      }

      logger.warn({ hostname }, "No matching zone found for hostname");
      return null;
    } catch (error) {
      logger.error({ error, hostname }, "Failed to find zone for hostname");
      throw error;
    }
  }

  async createDNSRecord(
    zoneId: string,
    record: CreateCloudflareDNSRecordRequest,
  ): Promise<CloudflareDNSRecord> {
    logger.info(
      { zoneId, recordType: record.type, recordName: record.name },
      "Creating DNS record",
    );

    try {
      const { cf } = await this.runner.getAuthorizedClient({
        requireAccountId: false,
      });
      const raw = await this.runner.withTimeout(
        cf.dns.records.create({
          zone_id: zoneId,
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl || 300,
          proxied: record.proxied ?? false,
        } as RecordCreateParams),
        "DNS record create",
      );

      const dnsRecord = toDnsRecord(raw, zoneId);
      logger.info(
        {
          zoneId,
          recordId: dnsRecord.id,
          recordType: dnsRecord.type,
          recordName: dnsRecord.name,
        },
        "Successfully created DNS record",
      );
      return dnsRecord;
    } catch (error) {
      // Cloudflare returns "already exists" when a record with the same
      // name+type+content is created twice — return the existing record
      // so callers get idempotent-looking behaviour.
      const message = error instanceof Error ? error.message : "";
      if (message.includes("already exists")) {
        logger.warn({ zoneId, recordName: record.name }, "DNS record already exists");
        const existing = await this.findDNSRecord(zoneId, record.name);
        if (existing) {
          logger.info(
            { zoneId, recordId: existing.id },
            "Returning existing DNS record",
          );
          return existing;
        }
      }

      logger.error({ error, zoneId, record }, "Failed to create DNS record");
      throw new Error(`Failed to create DNS record: ${error}`, { cause: error });
    }
  }

  async updateDNSRecord(
    zoneId: string,
    recordId: string,
    updates: UpdateCloudflareDNSRecordRequest,
  ): Promise<CloudflareDNSRecord> {
    logger.info({ zoneId, recordId, updates }, "Updating DNS record");

    try {
      const { cf } = await this.runner.getAuthorizedClient({
        requireAccountId: false,
      });
      const raw = await this.runner.withTimeout(
        cf.dns.records.update(recordId, {
          zone_id: zoneId,
          ...updates,
        } as RecordUpdateParams),
        "DNS record update",
      );

      const dnsRecord = toDnsRecord(raw, zoneId);
      logger.info(
        { zoneId, recordId, recordName: dnsRecord.name },
        "Successfully updated DNS record",
      );
      return dnsRecord;
    } catch (error) {
      logger.error(
        { error, zoneId, recordId, updates },
        "Failed to update DNS record",
      );
      throw new Error(`Failed to update DNS record: ${error}`, { cause: error });
    }
  }

  async deleteDNSRecord(zoneId: string, recordId: string): Promise<void> {
    logger.info({ zoneId, recordId }, "Deleting DNS record");

    try {
      const { cf } = await this.runner.getAuthorizedClient({
        requireAccountId: false,
      });
      await this.runner.withTimeout(
        cf.dns.records.delete(recordId, { zone_id: zoneId }),
        "DNS record delete",
      );

      logger.info({ zoneId, recordId }, "Successfully deleted DNS record");
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.warn(
          { zoneId, recordId },
          "DNS record not found, considering it already deleted",
        );
        return;
      }

      logger.error(
        { error, zoneId, recordId },
        "Failed to delete DNS record",
      );
      throw new Error(`Failed to delete DNS record: ${error}`, { cause: error });
    }
  }

  async getDNSRecord(
    zoneId: string,
    recordId: string,
  ): Promise<CloudflareDNSRecord | null> {
    logger.info({ zoneId, recordId }, "Getting DNS record");

    try {
      const { cf } = await this.runner.getAuthorizedClient({
        requireAccountId: false,
      });
      const raw = await this.runner.withTimeout(
        cf.dns.records.get(recordId, { zone_id: zoneId }),
        "DNS record get",
      );

      const dnsRecord = toDnsRecord(raw, zoneId);
      logger.info(
        { zoneId, recordId, recordName: dnsRecord.name },
        "Retrieved DNS record",
      );
      return dnsRecord;
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.warn({ zoneId, recordId }, "DNS record not found");
        return null;
      }
      logger.error({ error, zoneId, recordId }, "Failed to get DNS record");
      throw new Error(`Failed to get DNS record: ${error}`, { cause: error });
    }
  }

  async listDNSRecords(
    zoneId: string,
    hostname?: string,
  ): Promise<CloudflareDNSRecord[]> {
    logger.info({ zoneId, hostname }, "Listing DNS records");

    try {
      const { cf } = await this.runner.getAuthorizedClient({
        requireAccountId: false,
      });
      const params: RecordListParams = { zone_id: zoneId };
      if (hostname) {
        // SDK uses an object filter for name; { exact } performs exact-match.
        params.name = { exact: hostname };
      }

      const response = await this.runner.withTimeout(
        cf.dns.records.list(params),
        "DNS records list",
      );

      const records = response.result.map((raw: RecordResponse) =>
        toDnsRecord(raw, zoneId),
      );
      logger.info(
        { zoneId, hostname, recordCount: records.length },
        "Retrieved DNS records",
      );
      return records;
    } catch (error) {
      logger.error(
        { error, zoneId, hostname },
        "Failed to list DNS records",
      );
      throw new Error(`Failed to list DNS records: ${error}`, { cause: error });
    }
  }

  async findDNSRecord(
    zoneId: string,
    hostname: string,
  ): Promise<CloudflareDNSRecord | null> {
    logger.info({ zoneId, hostname }, "Finding DNS record by hostname");

    try {
      const records = await this.listDNSRecords(zoneId, hostname);
      if (records.length === 0) {
        logger.warn({ zoneId, hostname }, "No DNS record found for hostname");
        return null;
      }
      const record = records[0];
      logger.info(
        { zoneId, hostname, recordId: record.id },
        "Found DNS record for hostname",
      );
      return record;
    } catch (error) {
      logger.error({ error, zoneId, hostname }, "Failed to find DNS record");
      throw error;
    }
  }

  async upsertARecord(
    hostname: string,
    ipAddress: string,
    ttl: number = 300,
    proxied: boolean = false,
  ): Promise<CloudflareDNSRecord> {
    logger.info(
      { hostname, ipAddress, ttl, proxied },
      "Upserting DNS A record",
    );

    try {
      const zone = await this.findZoneForHostname(hostname);
      if (!zone) {
        throw new Error(
          `No Cloudflare zone found for hostname: ${hostname}. Please ensure the zone is configured in Cloudflare.`,
        );
      }

      const existing = await this.findDNSRecord(zone.id, hostname);
      if (existing) {
        logger.info(
          { hostname, recordId: existing.id },
          "Updating existing A record",
        );
        return this.updateDNSRecord(zone.id, existing.id, {
          type: "A",
          name: hostname,
          content: ipAddress,
          ttl,
          proxied,
        });
      }

      logger.info({ hostname, zoneId: zone.id }, "Creating new A record");
      return this.createDNSRecord(zone.id, {
        type: "A",
        name: hostname,
        content: ipAddress,
        ttl,
        proxied,
      });
    } catch (error) {
      logger.error(
        { error, hostname, ipAddress },
        "Failed to upsert DNS A record",
      );
      throw error;
    }
  }

  /**
   * Upsert a proxied CNAME pointing a hostname at a Cloudflare tunnel.
   * Records are orange-clouded by default — the standard configuration
   * for tunnel hostnames so Cloudflare handles TLS termination.
   */
  async upsertCNAMERecord(
    hostname: string,
    tunnelId: string,
  ): Promise<CloudflareDNSRecord> {
    const cnameTarget = `${tunnelId}.cfargotunnel.com`;
    logger.info(
      { hostname, tunnelId, cnameTarget },
      "Upserting DNS CNAME record for tunnel",
    );

    try {
      const zone = await this.findZoneForHostname(hostname);
      if (!zone) {
        throw new Error(
          `No Cloudflare zone found for hostname: ${hostname}. Please ensure the zone is configured in Cloudflare.`,
        );
      }

      const existing = await this.findDNSRecord(zone.id, hostname);
      if (existing) {
        if (
          existing.type === "CNAME" &&
          existing.content === cnameTarget &&
          existing.proxied
        ) {
          logger.info(
            { hostname, recordId: existing.id },
            "CNAME record already correct, no update needed",
          );
          return existing;
        }

        logger.info(
          {
            hostname,
            recordId: existing.id,
            existingType: existing.type,
          },
          "Updating existing record to CNAME for tunnel",
        );
        return this.updateDNSRecord(zone.id, existing.id, {
          type: "CNAME",
          name: hostname,
          content: cnameTarget,
          ttl: 1, // Auto TTL when proxied
          proxied: true,
        });
      }

      logger.info(
        { hostname, zoneId: zone.id },
        "Creating new CNAME record for tunnel",
      );
      return this.createDNSRecord(zone.id, {
        type: "CNAME",
        name: hostname,
        content: cnameTarget,
        ttl: 1,
        proxied: true,
      });
    } catch (error) {
      logger.error(
        { error, hostname, tunnelId },
        "Failed to upsert DNS CNAME record for tunnel",
      );
      throw error;
    }
  }

  /**
   * Remove a tunnel CNAME record for a hostname, leaving non-CNAME records
   * (A records, manually created entries) alone so we never clobber
   * unrelated zone data.
   */
  async deleteCNAMEByHostname(hostname: string): Promise<boolean> {
    logger.info({ hostname }, "Deleting DNS CNAME record for tunnel hostname");

    try {
      const zone = await this.findZoneForHostname(hostname);
      if (!zone) {
        logger.warn(
          { hostname },
          "No Cloudflare zone found for hostname, skipping CNAME deletion",
        );
        return false;
      }

      const existing = await this.findDNSRecord(zone.id, hostname);
      if (!existing) {
        logger.info(
          { hostname },
          "No DNS record found for hostname, nothing to delete",
        );
        return false;
      }

      if (existing.type !== "CNAME") {
        logger.warn(
          {
            hostname,
            recordType: existing.type,
            recordId: existing.id,
          },
          "DNS record is not a CNAME, skipping deletion to avoid removing unrelated record",
        );
        return false;
      }

      await this.deleteDNSRecord(zone.id, existing.id);
      logger.info(
        { hostname, recordId: existing.id },
        "Successfully deleted DNS CNAME record for tunnel hostname",
      );
      return true;
    } catch (error) {
      logger.error(
        { error, hostname },
        "Failed to delete DNS CNAME record for tunnel hostname",
      );
      throw error;
    }
  }
}

export const cloudflareDNSService = new CloudflareDNSService();
