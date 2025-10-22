import { servicesLogger } from '../lib/logger-factory';
import Cloudflare from 'cloudflare';
import {
  CloudflareDNSZone,
  CloudflareDNSRecord,
  CreateCloudflareDNSRecordRequest,
  UpdateCloudflareDNSRecordRequest
} from '@mini-infra/types';
import { CloudflareConfigService } from './cloudflare-config';
import prisma from '../lib/prisma';

const logger = servicesLogger();

/**
 * CloudFlare DNS Management Service
 * Handles DNS zone and record management via CloudFlare API
 */
export class CloudFlareDNSService {
  private cloudflareConfigService: CloudflareConfigService;

  constructor() {
    this.cloudflareConfigService = new CloudflareConfigService(prisma);
  }

  /**
   * Get a configured Cloudflare client
   * @throws Error if CloudFlare is not configured
   */
  private async getCloudflareClient(): Promise<Cloudflare> {
    const config = await this.cloudflareConfigService.getConfig();

    if (!config) {
      throw new Error('CloudFlare is not configured');
    }

    const apiToken = config.api_token;
    if (!apiToken) {
      throw new Error('CloudFlare API token is not configured');
    }

    return new Cloudflare({
      apiToken: apiToken
    });
  }

  /**
   * List all DNS zones in CloudFlare account
   */
  async listZones(): Promise<CloudflareDNSZone[]> {
    logger.info('Listing CloudFlare DNS zones');

    try {
      const client = await this.getCloudflareClient();
      const response = await client.zones.list();

      const zones: CloudflareDNSZone[] = response.result.map((zone: any) => ({
        id: zone.id,
        name: zone.name,
        status: zone.status,
        paused: zone.paused,
        type: zone.type,
        development_mode: zone.development_mode,
        name_servers: zone.name_servers,
        original_name_servers: zone.original_name_servers,
        original_registrar: zone.original_registrar,
        original_dnshost: zone.original_dnshost,
        created_on: zone.created_on,
        modified_on: zone.modified_on
      }));

      logger.info({ count: zones.length }, 'Retrieved CloudFlare DNS zones');
      return zones;
    } catch (error) {
      logger.error({ error }, 'Failed to list CloudFlare DNS zones');
      throw new Error(`Failed to list DNS zones: ${error.message}`);
    }
  }

  /**
   * Find the appropriate zone for a hostname
   * Example: api.example.com → finds example.com zone
   */
  async findZoneForHostname(hostname: string): Promise<CloudflareDNSZone | null> {
    logger.info({ hostname }, 'Finding zone for hostname');

    try {
      const zones = await this.listZones();

      // Extract domain from hostname (e.g., api.example.com → example.com)
      const parts = hostname.split('.');

      // Try matching from most specific to least specific
      // For api.sub.example.com, try: api.sub.example.com, sub.example.com, example.com
      for (let i = 0; i < parts.length - 1; i++) {
        const candidateDomain = parts.slice(i).join('.');
        const zone = zones.find(z => z.name === candidateDomain);

        if (zone) {
          logger.info({ hostname, zoneName: zone.name, zoneId: zone.id }, 'Found matching zone');
          return zone;
        }
      }

      logger.warn({ hostname }, 'No matching zone found for hostname');
      return null;
    } catch (error) {
      logger.error({ error, hostname }, 'Failed to find zone for hostname');
      throw error;
    }
  }

  /**
   * Create a DNS A record
   */
  async createDNSRecord(
    zoneId: string,
    record: CreateCloudflareDNSRecordRequest
  ): Promise<CloudflareDNSRecord> {
    logger.info({ zoneId, record }, 'Creating DNS record');

    try {
      const client = await this.getCloudflareClient();

      const response = await client.dns.records.create({
        zone_id: zoneId,
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl || 300, // Default 5 minutes
        proxied: record.proxied !== undefined ? record.proxied : false
      });

      const dnsRecord: CloudflareDNSRecord = {
        id: response.id,
        type: response.type,
        name: response.name,
        content: response.content,
        proxiable: response.proxiable,
        proxied: response.proxied,
        ttl: response.ttl,
        locked: response.locked,
        zone_id: response.zone_id,
        zone_name: response.zone_name,
        created_on: response.created_on,
        modified_on: response.modified_on,
        data: response.data,
        meta: response.meta
      };

      logger.info(
        { recordId: dnsRecord.id, name: dnsRecord.name, content: dnsRecord.content },
        'DNS record created successfully'
      );

      return dnsRecord;
    } catch (error) {
      logger.error({ error, zoneId, record }, 'Failed to create DNS record');
      throw new Error(`Failed to create DNS record: ${error.message}`);
    }
  }

  /**
   * Update an existing DNS record
   */
  async updateDNSRecord(
    zoneId: string,
    recordId: string,
    updates: UpdateCloudflareDNSRecordRequest
  ): Promise<CloudflareDNSRecord> {
    logger.info({ zoneId, recordId, updates }, 'Updating DNS record');

    try {
      const client = await this.getCloudflareClient();

      // Get current record first to merge with updates
      const current = await client.dns.records.get({
        zone_id: zoneId,
        dns_record_id: recordId
      });

      const response = await client.dns.records.update({
        zone_id: zoneId,
        dns_record_id: recordId,
        type: updates.type || current.type,
        name: updates.name || current.name,
        content: updates.content || current.content,
        ttl: updates.ttl !== undefined ? updates.ttl : current.ttl,
        proxied: updates.proxied !== undefined ? updates.proxied : current.proxied
      });

      const dnsRecord: CloudflareDNSRecord = {
        id: response.id,
        type: response.type,
        name: response.name,
        content: response.content,
        proxiable: response.proxiable,
        proxied: response.proxied,
        ttl: response.ttl,
        locked: response.locked,
        zone_id: response.zone_id,
        zone_name: response.zone_name,
        created_on: response.created_on,
        modified_on: response.modified_on,
        data: response.data,
        meta: response.meta
      };

      logger.info(
        { recordId: dnsRecord.id, name: dnsRecord.name, content: dnsRecord.content },
        'DNS record updated successfully'
      );

      return dnsRecord;
    } catch (error) {
      logger.error({ error, zoneId, recordId }, 'Failed to update DNS record');
      throw new Error(`Failed to update DNS record: ${error.message}`);
    }
  }

  /**
   * Delete a DNS record
   */
  async deleteDNSRecord(zoneId: string, recordId: string): Promise<void> {
    logger.info({ zoneId, recordId }, 'Deleting DNS record');

    try {
      const client = await this.getCloudflareClient();

      await client.dns.records.delete({
        zone_id: zoneId,
        dns_record_id: recordId
      });

      logger.info({ zoneId, recordId }, 'DNS record deleted successfully');
    } catch (error) {
      logger.error({ error, zoneId, recordId }, 'Failed to delete DNS record');
      throw new Error(`Failed to delete DNS record: ${error.message}`);
    }
  }

  /**
   * Get details of a specific DNS record
   */
  async getDNSRecord(zoneId: string, recordId: string): Promise<CloudflareDNSRecord> {
    logger.info({ zoneId, recordId }, 'Getting DNS record details');

    try {
      const client = await this.getCloudflareClient();

      const response = await client.dns.records.get({
        zone_id: zoneId,
        dns_record_id: recordId
      });

      const dnsRecord: CloudflareDNSRecord = {
        id: response.id,
        type: response.type,
        name: response.name,
        content: response.content,
        proxiable: response.proxiable,
        proxied: response.proxied,
        ttl: response.ttl,
        locked: response.locked,
        zone_id: response.zone_id,
        zone_name: response.zone_name,
        created_on: response.created_on,
        modified_on: response.modified_on,
        data: response.data,
        meta: response.meta
      };

      logger.info({ recordId: dnsRecord.id }, 'Retrieved DNS record details');
      return dnsRecord;
    } catch (error) {
      logger.error({ error, zoneId, recordId }, 'Failed to get DNS record');
      throw new Error(`Failed to get DNS record: ${error.message}`);
    }
  }

  /**
   * List all DNS records in a zone, optionally filtered by hostname
   */
  async listDNSRecords(zoneId: string, hostname?: string): Promise<CloudflareDNSRecord[]> {
    logger.info({ zoneId, hostname }, 'Listing DNS records');

    try {
      const client = await this.getCloudflareClient();

      const params: any = { zone_id: zoneId };
      if (hostname) {
        params.name = hostname;
      }

      const response = await client.dns.records.list(params);

      const records: CloudflareDNSRecord[] = response.result.map((record: any) => ({
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
        meta: record.meta
      }));

      logger.info({ zoneId, count: records.length }, 'Retrieved DNS records');
      return records;
    } catch (error) {
      logger.error({ error, zoneId, hostname }, 'Failed to list DNS records');
      throw new Error(`Failed to list DNS records: ${error.message}`);
    }
  }

  /**
   * Find an existing DNS record by hostname and type
   */
  async findDNSRecordByHostname(
    hostname: string,
    type: 'A' | 'AAAA' | 'CNAME' = 'A'
  ): Promise<{ zone: CloudflareDNSZone; record: CloudflareDNSRecord } | null> {
    logger.info({ hostname, type }, 'Finding DNS record by hostname');

    try {
      // Find the zone first
      const zone = await this.findZoneForHostname(hostname);
      if (!zone) {
        logger.warn({ hostname }, 'No zone found for hostname');
        return null;
      }

      // List records in the zone filtered by hostname
      const records = await this.listDNSRecords(zone.id, hostname);

      // Find record matching the type
      const record = records.find(r => r.type === type);

      if (record) {
        logger.info({ hostname, recordId: record.id }, 'Found existing DNS record');
        return { zone, record };
      }

      logger.info({ hostname }, 'No existing DNS record found');
      return null;
    } catch (error) {
      logger.error({ error, hostname, type }, 'Failed to find DNS record by hostname');
      throw error;
    }
  }

  /**
   * Create or update a DNS A record for a hostname
   * This is a convenience method for deployment use cases
   */
  async upsertDNSRecord(
    hostname: string,
    ipAddress: string,
    ttl: number = 300,
    proxied: boolean = false
  ): Promise<{ zone: CloudflareDNSZone; record: CloudflareDNSRecord; created: boolean }> {
    logger.info({ hostname, ipAddress, ttl, proxied }, 'Upserting DNS record');

    try {
      // Check if record already exists
      const existing = await this.findDNSRecordByHostname(hostname, 'A');

      if (existing) {
        // Update existing record
        logger.info({ hostname, recordId: existing.record.id }, 'Updating existing DNS record');
        const updated = await this.updateDNSRecord(existing.zone.id, existing.record.id, {
          content: ipAddress,
          ttl,
          proxied
        });

        return {
          zone: existing.zone,
          record: updated,
          created: false
        };
      } else {
        // Create new record
        logger.info({ hostname }, 'Creating new DNS record');
        const zone = await this.findZoneForHostname(hostname);

        if (!zone) {
          throw new Error(`No DNS zone found for hostname: ${hostname}`);
        }

        const created = await this.createDNSRecord(zone.id, {
          type: 'A',
          name: hostname,
          content: ipAddress,
          ttl,
          proxied
        });

        return {
          zone,
          record: created,
          created: true
        };
      }
    } catch (error) {
      logger.error({ error, hostname, ipAddress }, 'Failed to upsert DNS record');
      throw error;
    }
  }
}

// Export singleton instance
export const cloudflareDNSService = new CloudFlareDNSService();
