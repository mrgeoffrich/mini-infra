import { PrismaClient } from "../../lib/prisma";
import { servicesLogger } from "../../lib/logger-factory";
import { cloudflareDNSService } from "../cloudflare";
import { DnsCachedZone, DnsCachedRecord, DnsHostnameCheckResult } from "@mini-infra/types";

const logger = servicesLogger();

export class DnsCacheService {
  private prisma: PrismaClient;
  private isRefreshing = false;
  private static instance: DnsCacheService | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  static getInstance(prisma?: PrismaClient): DnsCacheService | null {
    if (!DnsCacheService.instance && prisma) {
      DnsCacheService.instance = new DnsCacheService(prisma);
    }
    return DnsCacheService.instance;
  }

  static setInstance(instance: DnsCacheService): void {
    DnsCacheService.instance = instance;
  }

  /**
   * Refresh the DNS cache by fetching all zones and records from Cloudflare.
   * Uses an isRefreshing guard to prevent concurrent refreshes.
   */
  async refreshCache(): Promise<{ zonesUpdated: number; recordsUpdated: number }> {
    if (this.isRefreshing) {
      logger.warn("DNS cache refresh already in progress, skipping");
      return { zonesUpdated: 0, recordsUpdated: 0 };
    }

    this.isRefreshing = true;
    logger.info("Starting DNS cache refresh from Cloudflare");

    try {
      const zones = await cloudflareDNSService.listZones();
      const seenZoneIds = new Set<string>();
      const seenRecordIds = new Set<string>();
      const failedZoneCfIds = new Set<string>();
      let totalRecords = 0;

      // Process zones in batches of 3 to avoid rate limiting
      for (let i = 0; i < zones.length; i += 3) {
        const batch = zones.slice(i, i + 3);
        const results = await Promise.allSettled(
          batch.map(async (zone) => {
            // Upsert zone
            const dbZone = await this.prisma.dnsCacheZone.upsert({
              where: { cloudflareZoneId: zone.id },
              create: {
                cloudflareZoneId: zone.id,
                name: zone.name,
                status: zone.status,
                paused: zone.paused,
                type: zone.type,
                nameServers: JSON.stringify(zone.name_servers || []),
                createdOn: zone.created_on || null,
                modifiedOn: zone.modified_on || null,
                cachedAt: new Date(),
              },
              update: {
                name: zone.name,
                status: zone.status,
                paused: zone.paused,
                type: zone.type,
                nameServers: JSON.stringify(zone.name_servers || []),
                createdOn: zone.created_on || null,
                modifiedOn: zone.modified_on || null,
                cachedAt: new Date(),
              },
            });

            seenZoneIds.add(dbZone.id);

            // Fetch and upsert records for this zone
            const records = await cloudflareDNSService.listDNSRecords(zone.id);
            await this.upsertRecordsBatch(dbZone.id, zone.name, records, seenRecordIds);

            totalRecords += records.length;
            return { zoneName: zone.name, recordCount: records.length };
          })
        );

        for (let j = 0; j < results.length; j++) {
          if (results[j].status === "rejected") {
            failedZoneCfIds.add(batch[j].id);
            logger.error({ error: (results[j] as PromiseRejectedResult).reason }, "Failed to cache zone data");
          }
        }
      }

      // Preserve cached data for zones that failed to refresh
      if (failedZoneCfIds.size > 0) {
        const failedDbZones = await this.prisma.dnsCacheZone.findMany({
          where: { cloudflareZoneId: { in: Array.from(failedZoneCfIds) } },
          include: { records: { select: { id: true } } },
        });
        for (const z of failedDbZones) {
          seenZoneIds.add(z.id);
          for (const r of z.records) {
            seenRecordIds.add(r.id);
          }
        }
      }

      // Delete stale records (records not seen in the current fetch)
      if (seenRecordIds.size > 0) {
        await this.prisma.dnsCacheRecord.deleteMany({
          where: { id: { notIn: Array.from(seenRecordIds) } },
        });
      }

      // Delete stale zones (zones not seen in the current fetch)
      if (seenZoneIds.size > 0) {
        await this.prisma.dnsCacheZone.deleteMany({
          where: { id: { notIn: Array.from(seenZoneIds) } },
        });
      } else if (zones.length === 0) {
        // If no zones returned, clear all cached data
        await this.prisma.dnsCacheRecord.deleteMany({});
        await this.prisma.dnsCacheZone.deleteMany({});
      }

      logger.info(
        { zonesUpdated: zones.length, recordsUpdated: totalRecords },
        "DNS cache refresh completed"
      );

      return { zonesUpdated: zones.length, recordsUpdated: totalRecords };
    } catch (error) {
      logger.error({ error }, "Failed to refresh DNS cache");
      throw error;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Batch upsert DNS records for a zone.
   * Deletes existing records for the zone and creates all new ones in a single transaction,
   * which is faster than individual upserts for zones with many records.
   */
  private async upsertRecordsBatch(
    dbZoneId: string,
    zoneName: string,
    records: Array<{
      id: string;
      type: string;
      name: string;
      content: string;
      ttl: number;
      proxied: boolean;
      proxiable: boolean;
      locked: boolean;
      created_on?: string | null;
      modified_on?: string | null;
    }>,
    seenRecordIds: Set<string>
  ): Promise<void> {
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Delete old records for this zone
      await tx.dnsCacheRecord.deleteMany({ where: { zoneId: dbZoneId } });

      // Bulk create all records
      if (records.length > 0) {
        await tx.dnsCacheRecord.createMany({
          data: records.map((record) => ({
            cloudflareRecordId: record.id,
            zoneId: dbZoneId,
            type: record.type,
            name: record.name,
            content: record.content,
            ttl: record.ttl,
            proxied: record.proxied,
            proxiable: record.proxiable,
            locked: record.locked,
            zoneName,
            createdOn: record.created_on || null,
            modifiedOn: record.modified_on || null,
            cachedAt: now,
          })),
        });
      }
    });

    // Track the new record IDs for stale cleanup
    const newRecords = await this.prisma.dnsCacheRecord.findMany({
      where: { zoneId: dbZoneId },
      select: { id: true },
    });
    for (const r of newRecords) {
      seenRecordIds.add(r.id);
    }
  }

  /**
   * Get all cached zones with record counts
   */
  async getZones(): Promise<DnsCachedZone[]> {
    const zones = await this.prisma.dnsCacheZone.findMany({
      include: { _count: { select: { records: true } } },
      orderBy: { name: "asc" },
    });

    return zones.map((z) => ({
      id: z.id,
      cloudflareZoneId: z.cloudflareZoneId,
      name: z.name,
      status: z.status,
      paused: z.paused,
      type: z.type,
      nameServers: JSON.parse(z.nameServers) as string[],
      createdOn: z.createdOn,
      modifiedOn: z.modifiedOn,
      cachedAt: z.cachedAt.toISOString(),
      recordCount: z._count.records,
    }));
  }

  /**
   * Get all cached records for a specific zone
   */
  async getRecordsForZone(zoneId: string): Promise<DnsCachedRecord[]> {
    const records = await this.prisma.dnsCacheRecord.findMany({
      where: { zoneId },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });

    return records.map((r) => ({
      id: r.id,
      cloudflareRecordId: r.cloudflareRecordId,
      type: r.type,
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      proxied: r.proxied,
      proxiable: r.proxiable,
      locked: r.locked,
      zoneName: r.zoneName,
      createdOn: r.createdOn,
      modifiedOn: r.modifiedOn,
    }));
  }

  /**
   * Get the zone for a specific zone ID including record count
   */
  async getZone(zoneId: string): Promise<DnsCachedZone | null> {
    const zone = await this.prisma.dnsCacheZone.findUnique({
      where: { id: zoneId },
      include: { _count: { select: { records: true } } },
    });

    if (!zone) return null;

    return {
      id: zone.id,
      cloudflareZoneId: zone.cloudflareZoneId,
      name: zone.name,
      status: zone.status,
      paused: zone.paused,
      type: zone.type,
      nameServers: JSON.parse(zone.nameServers) as string[],
      createdOn: zone.createdOn,
      modifiedOn: zone.modifiedOn,
      cachedAt: zone.cachedAt.toISOString(),
      recordCount: zone._count.records,
    };
  }

  /**
   * Get the timestamp of the most recent cache refresh
   */
  async getLastRefreshedAt(): Promise<Date | null> {
    const result = await this.prisma.dnsCacheZone.aggregate({
      _max: { cachedAt: true },
    });
    return result._max.cachedAt;
  }

  /**
   * Find the matching DNS zone for a hostname using cached data.
   * Tries progressively shorter domain suffixes.
   */
  async findZoneForHostname(hostname: string): Promise<DnsCachedZone | null> {
    const parts = hostname.toLowerCase().split(".");

    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join(".");
      const zone = await this.prisma.dnsCacheZone.findFirst({
        where: { name: candidate },
        include: { _count: { select: { records: true } } },
      });

      if (zone) {
        return {
          id: zone.id,
          cloudflareZoneId: zone.cloudflareZoneId,
          name: zone.name,
          status: zone.status,
          paused: zone.paused,
          type: zone.type,
          nameServers: JSON.parse(zone.nameServers) as string[],
          createdOn: zone.createdOn,
          modifiedOn: zone.modifiedOn,
          cachedAt: zone.cachedAt.toISOString(),
          recordCount: zone._count.records,
        };
      }
    }

    return null;
  }

  /**
   * Find cached DNS records matching a hostname
   */
  async findRecordsForHostname(hostname: string): Promise<DnsCachedRecord[]> {
    const records = await this.prisma.dnsCacheRecord.findMany({
      where: { name: hostname.toLowerCase() },
      orderBy: [{ type: "asc" }],
    });

    return records.map((r) => ({
      id: r.id,
      cloudflareRecordId: r.cloudflareRecordId,
      type: r.type,
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      proxied: r.proxied,
      proxiable: r.proxiable,
      locked: r.locked,
      zoneName: r.zoneName,
      createdOn: r.createdOn,
      modifiedOn: r.modifiedOn,
    }));
  }

  /**
   * Check hostname against cached DNS data and return validation info
   */
  async checkHostname(hostname: string): Promise<DnsHostnameCheckResult> {
    const zone = await this.findZoneForHostname(hostname);

    if (!zone) {
      return { matchedZone: false };
    }

    const records = await this.findRecordsForHostname(hostname);

    return {
      matchedZone: true,
      zoneName: zone.name,
      existingRecords: records.length > 0
        ? records.map((r) => ({
            type: r.type,
            content: r.content,
            proxied: r.proxied,
          }))
        : undefined,
    };
  }

  /**
   * Check if the cache has any data
   */
  async isCachePopulated(): Promise<boolean> {
    const count = await this.prisma.dnsCacheZone.count();
    return count > 0;
  }
}
