import type {
  RecordCreateParams,
  RecordResponse,
} from "cloudflare/resources/dns/records.js";
import { CloudflareApiRunner } from "./cloudflare-api-runner";

/**
 * Zone-scoped operations (zone lookup + DNS record CRUD) that go through
 * the shared {@link CloudflareApiRunner}. The richer DNS helpers
 * (listZones, upsertCNAMERecord, etc.) live in {@link CloudflareDNSService}
 * but reuse the same runner.
 */
export class CloudflareZoneApi {
  constructor(private readonly runner: CloudflareApiRunner) {}

  /**
   * Resolve a domain name to its Cloudflare zone ID. Throws if the token
   * lacks permission or no matching zone exists.
   */
  async getZoneId(domain: string): Promise<string> {
    return this.runner.run<string>(
      {
        label: "zone lookup",
        logContext: { domain },
        requireAccountId: false,
      },
      async ({ cf }) => {
        const response = await cf.zones.list({ name: domain });
        const zones = response.result ?? [];
        if (zones.length === 0) {
          throw new Error(`No Cloudflare zone found for domain: ${domain}`);
        }
        return zones[0].id;
      },
    );
  }

  async createDnsRecord(params: {
    zoneId: string;
    type: string;
    name: string;
    content: string;
    ttl: number;
  }): Promise<string> {
    return this.runner.run<string>(
      {
        label: "DNS record create",
        logContext: {
          zoneId: params.zoneId,
          type: params.type,
          name: params.name,
        },
        requireAccountId: false,
      },
      async ({ cf }) => {
        const response: RecordResponse = await cf.dns.records.create({
          zone_id: params.zoneId,
          type: params.type,
          name: params.name,
          content: params.content,
          ttl: params.ttl,
        } as RecordCreateParams);
        return response.id;
      },
    );
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    return this.runner.run<void>(
      {
        label: "DNS record delete",
        logContext: { zoneId, recordId },
        requireAccountId: false,
      },
      async ({ cf }) => {
        await cf.dns.records.delete(recordId, { zone_id: zoneId });
      },
    );
  }
}
