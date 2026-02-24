import Cloudflare from "cloudflare";
import { servicesLogger } from "../lib/logger-factory";
import { CloudflareService } from "./cloudflare-service";
import prisma from "../lib/prisma";
import {
  CloudflareDNSZone,
  CloudflareDNSRecord,
  CreateCloudflareDNSRecordRequest,
  UpdateCloudflareDNSRecordRequest,
} from "@mini-infra/types";

const logger = servicesLogger();

/**
 * CloudflareDNSService manages DNS zones and records in Cloudflare
 * Provides methods for DNS record lifecycle management
 */
export class CloudflareDNSService {
  private cloudflareConfigService: CloudflareService;
  private static readonly TIMEOUT_MS = 10000; // 10 second timeout

  constructor() {
    this.cloudflareConfigService = new CloudflareService(prisma);
  }

  /**
   * Get a Cloudflare API client instance
   * @returns Configured Cloudflare client
   * @throws Error if API token is not configured
   */
  private async getCloudflareClient(): Promise<Cloudflare> {
    const apiToken = await this.cloudflareConfigService.get("api_token");

    if (!apiToken) {
      throw new Error(
        "Cloudflare API token not configured. Please configure Cloudflare settings."
      );
    }

    return new Cloudflare({ apiToken });
  }

  /**
   * List all DNS zones in the Cloudflare account
   * @returns Array of DNS zones
   */
  async listZones(): Promise<CloudflareDNSZone[]> {
    logger.info("Listing Cloudflare DNS zones");

    try {
      const cf = await this.getCloudflareClient();

      const response = await Promise.race([
        cf.zones.list(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timeout")),
            CloudflareDNSService.TIMEOUT_MS
          )
        ),
      ]);

      const zones = response.result.map((zone: any) => ({
        id: zone.id,
        name: zone.name,
        status: zone.status,
        paused: zone.paused,
        type: zone.type,
        development_mode: zone.development_mode,
        name_servers: zone.name_servers || [],
        original_name_servers: zone.original_name_servers,
        original_registrar: zone.original_registrar,
        original_dnshost: zone.original_dnshost,
        created_on: zone.created_on,
        modified_on: zone.modified_on,
      }));

      logger.info({ zoneCount: zones.length }, "Retrieved Cloudflare DNS zones");
      return zones;
    } catch (error) {
      logger.error({ error }, "Failed to list Cloudflare DNS zones");
      throw new Error(`Failed to list DNS zones: ${error}`);
    }
  }

  /**
   * Find the appropriate DNS zone for a given hostname
   * For example: api.example.com -> example.com zone
   *
   * @param hostname The hostname to find a zone for
   * @returns The zone that matches the hostname, or null if not found
   */
  async findZoneForHostname(
    hostname: string
  ): Promise<CloudflareDNSZone | null> {
    logger.info({ hostname }, "Finding zone for hostname");

    try {
      const zones = await this.listZones();

      // Extract domain parts from hostname (e.g., api.example.com -> [api, example, com])
      const parts = hostname.toLowerCase().split(".");

      // Try to match from most specific to least specific
      // e.g., for api.example.com, try: api.example.com, example.com, com
      for (let i = 0; i < parts.length - 1; i++) {
        const candidateZone = parts.slice(i).join(".");

        const matchingZone = zones.find(
          (zone) => zone.name.toLowerCase() === candidateZone
        );

        if (matchingZone) {
          logger.info(
            { hostname, zoneName: matchingZone.name, zoneId: matchingZone.id },
            "Found matching zone for hostname"
          );
          return matchingZone;
        }
      }

      logger.warn({ hostname }, "No matching zone found for hostname");
      return null;
    } catch (error) {
      logger.error({ error, hostname }, "Failed to find zone for hostname");
      throw error;
    }
  }

  /**
   * Create a DNS record in a Cloudflare zone
   *
   * @param zoneId The zone ID to create the record in
   * @param record The DNS record to create
   * @returns The created DNS record
   */
  async createDNSRecord(
    zoneId: string,
    record: CreateCloudflareDNSRecordRequest
  ): Promise<CloudflareDNSRecord> {
    logger.info(
      { zoneId, recordType: record.type, recordName: record.name },
      "Creating DNS record"
    );

    try {
      const cf = await this.getCloudflareClient();

      const response: any = await Promise.race([
        cf.dns.records.create({
          zone_id: zoneId,
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl || 300, // Default to 5 minutes
          proxied: record.proxied ?? false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timeout")),
            CloudflareDNSService.TIMEOUT_MS
          )
        ),
      ]);

      const dnsRecord: CloudflareDNSRecord = {
        id: response.id,
        type: response.type,
        name: response.name || record.name,
        content: response.content || record.content,
        proxiable: response.proxiable ?? true,
        proxied: response.proxied ?? false,
        ttl: response.ttl,
        locked: response.locked ?? false,
        zone_id: response.zone_id || zoneId,
        zone_name: response.zone_name || "",
        created_on: response.created_on,
        modified_on: response.modified_on,
        data: response.data,
        meta: response.meta,
      };

      logger.info(
        {
          zoneId,
          recordId: dnsRecord.id,
          recordType: dnsRecord.type,
          recordName: dnsRecord.name,
        },
        "Successfully created DNS record"
      );

      return dnsRecord;
    } catch (error: any) {
      // Check if the error is due to record already existing
      if (error?.message?.includes("already exists")) {
        logger.warn(
          { zoneId, recordName: record.name },
          "DNS record already exists"
        );
        // Try to find the existing record
        const existingRecord = await this.findDNSRecord(zoneId, record.name);
        if (existingRecord) {
          logger.info(
            { zoneId, recordId: existingRecord.id },
            "Returning existing DNS record"
          );
          return existingRecord;
        }
      }

      logger.error(
        { error, zoneId, record },
        "Failed to create DNS record"
      );
      throw new Error(`Failed to create DNS record: ${error}`);
    }
  }

  /**
   * Update a DNS record in a Cloudflare zone
   *
   * @param zoneId The zone ID containing the record
   * @param recordId The ID of the record to update
   * @param updates The updates to apply to the record
   * @returns The updated DNS record
   */
  async updateDNSRecord(
    zoneId: string,
    recordId: string,
    updates: UpdateCloudflareDNSRecordRequest
  ): Promise<CloudflareDNSRecord> {
    logger.info(
      { zoneId, recordId, updates },
      "Updating DNS record"
    );

    try {
      const cf = await this.getCloudflareClient();

      const response: any = await Promise.race([
        cf.dns.records.update(recordId, {
          zone_id: zoneId,
          ...updates,
        } as any),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timeout")),
            CloudflareDNSService.TIMEOUT_MS
          )
        ),
      ]);

      const dnsRecord: CloudflareDNSRecord = {
        id: response.id,
        type: response.type,
        name: response.name || "",
        content: response.content || "",
        proxiable: response.proxiable ?? true,
        proxied: response.proxied ?? false,
        ttl: response.ttl,
        locked: response.locked ?? false,
        zone_id: response.zone_id || zoneId,
        zone_name: response.zone_name || "",
        created_on: response.created_on,
        modified_on: response.modified_on,
        data: response.data,
        meta: response.meta,
      };

      logger.info(
        { zoneId, recordId, recordName: dnsRecord.name },
        "Successfully updated DNS record"
      );

      return dnsRecord;
    } catch (error) {
      logger.error(
        { error, zoneId, recordId, updates },
        "Failed to update DNS record"
      );
      throw new Error(`Failed to update DNS record: ${error}`);
    }
  }

  /**
   * Delete a DNS record from a Cloudflare zone
   *
   * @param zoneId The zone ID containing the record
   * @param recordId The ID of the record to delete
   */
  async deleteDNSRecord(zoneId: string, recordId: string): Promise<void> {
    logger.info({ zoneId, recordId }, "Deleting DNS record");

    try {
      const cf = await this.getCloudflareClient();

      await Promise.race([
        cf.dns.records.delete(recordId, { zone_id: zoneId }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timeout")),
            CloudflareDNSService.TIMEOUT_MS
          )
        ),
      ]);

      logger.info({ zoneId, recordId }, "Successfully deleted DNS record");
    } catch (error: any) {
      // If record not found, consider it already deleted (idempotent)
      if (error?.message?.includes("not found") || error?.status === 404) {
        logger.warn(
          { zoneId, recordId },
          "DNS record not found, considering it already deleted"
        );
        return;
      }

      logger.error(
        { error, zoneId, recordId },
        "Failed to delete DNS record"
      );
      throw new Error(`Failed to delete DNS record: ${error}`);
    }
  }

  /**
   * Get a specific DNS record by ID
   *
   * @param zoneId The zone ID containing the record
   * @param recordId The ID of the record to retrieve
   * @returns The DNS record, or null if not found
   */
  async getDNSRecord(
    zoneId: string,
    recordId: string
  ): Promise<CloudflareDNSRecord | null> {
    logger.info({ zoneId, recordId }, "Getting DNS record");

    try {
      const cf = await this.getCloudflareClient();

      const response: any = await Promise.race([
        cf.dns.records.get(recordId, { zone_id: zoneId }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timeout")),
            CloudflareDNSService.TIMEOUT_MS
          )
        ),
      ]);

      const dnsRecord: CloudflareDNSRecord = {
        id: response.id,
        type: response.type,
        name: response.name || "",
        content: response.content || "",
        proxiable: response.proxiable ?? true,
        proxied: response.proxied ?? false,
        ttl: response.ttl,
        locked: response.locked ?? false,
        zone_id: response.zone_id || zoneId,
        zone_name: response.zone_name || "",
        created_on: response.created_on,
        modified_on: response.modified_on,
        data: response.data,
        meta: response.meta,
      };

      logger.info(
        { zoneId, recordId, recordName: dnsRecord.name },
        "Retrieved DNS record"
      );

      return dnsRecord;
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.status === 404) {
        logger.warn({ zoneId, recordId }, "DNS record not found");
        return null;
      }

      logger.error({ error, zoneId, recordId }, "Failed to get DNS record");
      throw new Error(`Failed to get DNS record: ${error}`);
    }
  }

  /**
   * List DNS records in a zone, optionally filtered by hostname
   *
   * @param zoneId The zone ID to list records from
   * @param hostname Optional hostname to filter by
   * @returns Array of DNS records
   */
  async listDNSRecords(
    zoneId: string,
    hostname?: string
  ): Promise<CloudflareDNSRecord[]> {
    logger.info({ zoneId, hostname }, "Listing DNS records");

    try {
      const cf = await this.getCloudflareClient();

      const params: any = { zone_id: zoneId };
      if (hostname) {
        params.name = hostname;
      }

      const response = await Promise.race([
        cf.dns.records.list(params),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timeout")),
            CloudflareDNSService.TIMEOUT_MS
          )
        ),
      ]);

      const records = response.result.map((record: any) => ({
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content,
        proxiable: record.proxiable,
        proxied: record.proxied,
        ttl: record.ttl,
        locked: record.locked,
        zone_id: record.zone_id,
        zone_name: record.zone_name,
        created_on: record.created_on,
        modified_on: record.modified_on,
        data: record.data,
        meta: record.meta,
      }));

      logger.info(
        { zoneId, hostname, recordCount: records.length },
        "Retrieved DNS records"
      );

      return records;
    } catch (error) {
      logger.error(
        { error, zoneId, hostname },
        "Failed to list DNS records"
      );
      throw new Error(`Failed to list DNS records: ${error}`);
    }
  }

  /**
   * Find a DNS record by hostname
   * This is a convenience method that searches for a record by name
   *
   * @param zoneId The zone ID to search in
   * @param hostname The hostname to search for
   * @returns The DNS record, or null if not found
   */
  async findDNSRecord(
    zoneId: string,
    hostname: string
  ): Promise<CloudflareDNSRecord | null> {
    logger.info({ zoneId, hostname }, "Finding DNS record by hostname");

    try {
      const records = await this.listDNSRecords(zoneId, hostname);

      if (records.length === 0) {
        logger.warn({ zoneId, hostname }, "No DNS record found for hostname");
        return null;
      }

      // Return the first matching record
      // In most cases there should only be one A record per hostname
      const record = records[0];
      logger.info(
        { zoneId, hostname, recordId: record.id },
        "Found DNS record for hostname"
      );

      return record;
    } catch (error) {
      logger.error(
        { error, zoneId, hostname },
        "Failed to find DNS record"
      );
      throw error;
    }
  }

  /**
   * Create or update a DNS A record for a hostname
   * If the record already exists, it will be updated with the new IP
   * If it doesn't exist, it will be created
   *
   * @param hostname The hostname for the A record
   * @param ipAddress The IP address to point to
   * @param ttl Optional TTL (defaults to 300 seconds)
   * @param proxied Optional proxied flag (defaults to false)
   * @returns The created or updated DNS record
   */
  async upsertARecord(
    hostname: string,
    ipAddress: string,
    ttl: number = 300,
    proxied: boolean = false
  ): Promise<CloudflareDNSRecord> {
    logger.info(
      { hostname, ipAddress, ttl, proxied },
      "Upserting DNS A record"
    );

    try {
      // Find the zone for this hostname
      const zone = await this.findZoneForHostname(hostname);
      if (!zone) {
        throw new Error(
          `No Cloudflare zone found for hostname: ${hostname}. Please ensure the zone is configured in Cloudflare.`
        );
      }

      // Check if a record already exists
      const existingRecord = await this.findDNSRecord(zone.id, hostname);

      if (existingRecord) {
        // Update existing record
        logger.info(
          { hostname, recordId: existingRecord.id },
          "Updating existing A record"
        );

        return await this.updateDNSRecord(zone.id, existingRecord.id, {
          type: "A",
          name: hostname,
          content: ipAddress,
          ttl,
          proxied,
        });
      } else {
        // Create new record
        logger.info({ hostname, zoneId: zone.id }, "Creating new A record");

        return await this.createDNSRecord(zone.id, {
          type: "A",
          name: hostname,
          content: ipAddress,
          ttl,
          proxied,
        });
      }
    } catch (error) {
      logger.error(
        { error, hostname, ipAddress },
        "Failed to upsert DNS A record"
      );
      throw error;
    }
  }
}

// Export singleton instance
export const cloudflareDNSService = new CloudflareDNSService();
