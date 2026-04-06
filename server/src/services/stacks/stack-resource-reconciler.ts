import type { PrismaClient } from '@prisma/client';
import type {
  StackTlsCertificate,
  StackDnsRecord,
  StackTunnelIngress,
  StackServiceDefinition,
  ResourceAction,
  ResourceResult,
  ResourceType,
  FieldDiff,
  PlanWarning,
} from '@mini-infra/types';
import type { CertificateLifecycleManager } from '../tls/certificate-lifecycle-manager';
import type { CloudflareDNSService } from '../cloudflare/cloudflare-dns';
import type { CloudflareService } from '../cloudflare/cloudflare-service';
import { servicesLogger } from '../../lib/logger-factory';

const log = servicesLogger().child({ service: 'stack-resource-reconciler' });

interface ResourceDefinitions {
  tlsCertificates: StackTlsCertificate[];
  dnsRecords: StackDnsRecord[];
  tunnelIngress: StackTunnelIngress[];
}

interface StackResourceRow {
  id: string;
  stackId: string;
  resourceType: string;
  resourceName: string;
  fqdn: string;
  externalId: string | null;
  externalState: any;
  status: string;
  error: string | null;
}

export class StackResourceReconciler {
  constructor(
    private prisma: PrismaClient,
    private certLifecycleManager: CertificateLifecycleManager,
    private cloudflareDns: CloudflareDNSService,
    private cloudflareService?: CloudflareService,
  ) {}

  // ════════════════════════════════════════════════════
  // planResources
  // ════════════════════════════════════════════════════

  planResources(definitions: ResourceDefinitions, currentResources: StackResourceRow[]): ResourceAction[] {
    const actions: ResourceAction[] = [];

    // Index current resources by (type, name)
    const currentMap = new Map<string, StackResourceRow>();
    for (const r of currentResources) {
      currentMap.set(`${r.resourceType}:${r.resourceName}`, r);
    }

    // Track which current resources are still referenced
    const matched = new Set<string>();

    // TLS
    for (const def of definitions.tlsCertificates) {
      const key = `tls:${def.name}`;
      matched.add(key);
      const current = currentMap.get(key);
      if (!current) {
        actions.push({ resourceType: 'tls', resourceName: def.name, action: 'create' });
      } else {
        const diffs = this.diffTls(def, current);
        if (diffs.length > 0) {
          actions.push({ resourceType: 'tls', resourceName: def.name, action: 'update', diff: diffs });
        } else {
          actions.push({ resourceType: 'tls', resourceName: def.name, action: 'no-op' });
        }
      }
    }

    // DNS
    for (const def of definitions.dnsRecords) {
      const key = `dns:${def.name}`;
      matched.add(key);
      const current = currentMap.get(key);
      if (!current) {
        actions.push({ resourceType: 'dns', resourceName: def.name, action: 'create' });
      } else {
        const diffs = this.diffDns(def, current);
        if (diffs.length > 0) {
          actions.push({ resourceType: 'dns', resourceName: def.name, action: 'update', diff: diffs });
        } else {
          actions.push({ resourceType: 'dns', resourceName: def.name, action: 'no-op' });
        }
      }
    }

    // Tunnel
    for (const def of definitions.tunnelIngress) {
      const key = `tunnel:${def.name}`;
      matched.add(key);
      const current = currentMap.get(key);
      if (!current) {
        actions.push({ resourceType: 'tunnel', resourceName: def.name, action: 'create' });
      } else {
        const diffs = this.diffTunnel(def, current);
        if (diffs.length > 0) {
          actions.push({ resourceType: 'tunnel', resourceName: def.name, action: 'update', diff: diffs });
        } else {
          actions.push({ resourceType: 'tunnel', resourceName: def.name, action: 'no-op' });
        }
      }
    }

    // Removals: resources in DB but not in definitions
    for (const [key, row] of currentMap) {
      if (!matched.has(key)) {
        actions.push({
          resourceType: row.resourceType as ResourceType,
          resourceName: row.resourceName,
          action: 'remove',
        });
      }
    }

    return actions;
  }

  private diffTls(def: StackTlsCertificate, current: StackResourceRow): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    if (def.fqdn !== current.fqdn) {
      diffs.push({ field: 'fqdn', old: current.fqdn, new: def.fqdn });
    }
    return diffs;
  }

  private diffDns(def: StackDnsRecord, current: StackResourceRow): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    const state = (current.externalState as { target?: string; ttl?: number; proxied?: boolean }) ?? {};
    const desiredTtl = def.ttl ?? 300;
    const desiredProxied = def.proxied ?? false;

    if (def.target !== state.target) {
      diffs.push({ field: 'target', old: state.target ?? null, new: def.target });
    }
    if (desiredTtl !== (state.ttl ?? 300)) {
      diffs.push({ field: 'ttl', old: String(state.ttl ?? 300), new: String(desiredTtl) });
    }
    if (desiredProxied !== (state.proxied ?? false)) {
      diffs.push({ field: 'proxied', old: String(state.proxied ?? false), new: String(desiredProxied) });
    }
    return diffs;
  }

  private diffTunnel(def: StackTunnelIngress, current: StackResourceRow): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    const state = (current.externalState as { fqdn?: string; service?: string }) ?? {};

    if (def.fqdn !== (state.fqdn ?? current.fqdn)) {
      diffs.push({ field: 'fqdn', old: state.fqdn ?? current.fqdn, new: def.fqdn });
    }
    if (def.service !== state.service) {
      diffs.push({ field: 'service', old: state.service ?? null, new: def.service });
    }
    return diffs;
  }

  // ════════════════════════════════════════════════════
  // reconcileTls
  // ════════════════════════════════════════════════════

  async reconcileTls(
    actions: ResourceAction[],
    stackId: string,
    definitions: StackTlsCertificate[],
    userId: string,
    onProgress?: (result: ResourceResult) => void,
  ): Promise<ResourceResult[]> {
    const results: ResourceResult[] = [];
    const defMap = new Map(definitions.map((d) => [d.name, d]));

    for (const action of actions) {
      if (action.resourceType !== 'tls' || action.action === 'no-op') continue;

      const def = defMap.get(action.resourceName);
      const result: ResourceResult = {
        resourceType: 'tls',
        resourceName: action.resourceName,
        action: action.action,
        success: false,
      };

      try {
        if (action.action === 'create' || action.action === 'update') {
          if (!def) {
            result.error = `No definition found for TLS resource ${action.resourceName}`;
            results.push(result);
            continue;
          }

          let certId: string;

          // Check for existing cert
          const existingCert = await this.prisma.tlsCertificate.findFirst({
            where: {
              primaryDomain: def.fqdn,
              status: { in: ['ACTIVE', 'RENEWING'] },
            },
          });

          if (existingCert) {
            certId = existingCert.id;
            log.info({ fqdn: def.fqdn, certId }, 'Reusing existing TLS certificate');
          } else {
            log.info({ fqdn: def.fqdn }, 'Provisioning new TLS certificate');
            // Don't deploy to HAProxy here — the deployment state machine's
            // configureFrontend step handles that once HAProxy is ready
            const cert = await this.certLifecycleManager.issueCertificate({
              primaryDomain: def.fqdn,
              domains: [def.fqdn],
              userId,
              deployToHaproxy: false,
            });
            certId = cert.id;
          }

          // Upsert stack resource record
          await this.prisma.stackResource.upsert({
            where: {
              stackId_resourceType_resourceName: {
                stackId,
                resourceType: 'tls',
                resourceName: action.resourceName,
              },
            },
            create: {
              stackId,
              resourceType: 'tls',
              resourceName: action.resourceName,
              fqdn: def.fqdn,
              externalId: certId,
              externalState: { fqdn: def.fqdn },
              status: 'active',
            },
            update: {
              fqdn: def.fqdn,
              externalId: certId,
              externalState: { fqdn: def.fqdn },
              status: 'active',
              error: null,
            },
          });

          result.success = true;
        } else if (action.action === 'remove') {
          // Remove the StackResource record only; cert stays in TLS store
          await this.prisma.stackResource.deleteMany({
            where: { stackId, resourceType: 'tls', resourceName: action.resourceName },
          });
          result.success = true;
        }
      } catch (err: any) {
        log.error({ err, resourceName: action.resourceName }, 'TLS reconciliation failed');
        result.error = err.message ?? String(err);
      }

      results.push(result);
      try { onProgress?.(result); } catch {}
    }

    return results;
  }

  // ════════════════════════════════════════════════════
  // reconcileDns
  // ════════════════════════════════════════════════════

  async reconcileDns(
    actions: ResourceAction[],
    stackId: string,
    definitions: StackDnsRecord[],
    onProgress?: (result: ResourceResult) => void,
  ): Promise<ResourceResult[]> {
    const results: ResourceResult[] = [];
    const defMap = new Map(definitions.map((d) => [d.name, d]));

    for (const action of actions) {
      if (action.resourceType !== 'dns' || action.action === 'no-op') continue;

      const def = defMap.get(action.resourceName);
      const result: ResourceResult = {
        resourceType: 'dns',
        resourceName: action.resourceName,
        action: action.action,
        success: false,
      };

      try {
        if (action.action === 'create' || action.action === 'update') {
          if (!def) {
            result.error = `No definition found for DNS resource ${action.resourceName}`;
            results.push(result);
            continue;
          }

          const ttl = def.ttl ?? 300;
          const proxied = def.proxied ?? false;

          log.info({ fqdn: def.fqdn, target: def.target, ttl, proxied }, 'Upserting DNS A record');

          const dnsRecord = await this.cloudflareDns.upsertARecord(def.fqdn, def.target, ttl, proxied);
          const zone = await this.cloudflareDns.findZoneForHostname(def.fqdn);

          await this.prisma.stackResource.upsert({
            where: {
              stackId_resourceType_resourceName: {
                stackId,
                resourceType: 'dns',
                resourceName: action.resourceName,
              },
            },
            create: {
              stackId,
              resourceType: 'dns',
              resourceName: action.resourceName,
              fqdn: def.fqdn,
              externalId: dnsRecord.id,
              externalState: { target: def.target, ttl, proxied, zoneId: zone?.id ?? null },
              status: 'active',
            },
            update: {
              fqdn: def.fqdn,
              externalId: dnsRecord.id,
              externalState: { target: def.target, ttl, proxied, zoneId: zone?.id ?? null },
              status: 'active',
              error: null,
            },
          });

          result.success = true;
        } else if (action.action === 'remove') {
          // Look up the resource to get external IDs
          const resources = await this.prisma.stackResource.findMany({
            where: { stackId, resourceType: 'dns', resourceName: action.resourceName },
          });

          for (const resource of resources) {
            const state = resource.externalState as { zoneId?: string } | null;
            if (resource.externalId && state?.zoneId) {
              await this.cloudflareDns.deleteDNSRecord(state.zoneId, resource.externalId);
            }
          }

          await this.prisma.stackResource.deleteMany({
            where: { stackId, resourceType: 'dns', resourceName: action.resourceName },
          });

          result.success = true;
        }
      } catch (err: any) {
        log.error({ err, resourceName: action.resourceName }, 'DNS reconciliation failed');
        result.error = err.message ?? String(err);
      }

      results.push(result);
      try { onProgress?.(result); } catch {}
    }

    return results;
  }

  // ════════════════════════════════════════════════════
  // reconcileTunnel
  // ════════════════════════════════════════════════════

  async reconcileTunnel(
    actions: ResourceAction[],
    stackId: string,
    definitions: StackTunnelIngress[],
    onProgress?: (result: ResourceResult) => void,
  ): Promise<ResourceResult[]> {
    const results: ResourceResult[] = [];
    const defMap = new Map(definitions.map((d) => [d.name, d]));

    // Look up environment tunnel config
    const stack = await this.prisma.stack.findUnique({
      where: { id: stackId },
      select: { environmentId: true },
    });
    let tunnelId: string | null = null;
    let tunnelServiceUrl: string | null = null;
    if (stack?.environmentId) {
      const env = await this.prisma.environment.findUnique({
        where: { id: stack.environmentId },
        select: { tunnelId: true, tunnelServiceUrl: true },
      });
      tunnelId = env?.tunnelId ?? null;
      tunnelServiceUrl = env?.tunnelServiceUrl ?? null;
    }

    for (const action of actions) {
      if (action.resourceType !== 'tunnel' || action.action === 'no-op') continue;

      const def = defMap.get(action.resourceName);
      const result: ResourceResult = {
        resourceType: 'tunnel',
        resourceName: action.resourceName,
        action: action.action,
        success: false,
      };

      try {
        if (action.action === 'create' || action.action === 'update') {
          if (!def) {
            result.error = `No definition found for tunnel resource ${action.resourceName}`;
            results.push(result);
            continue;
          }

          // Call Cloudflare API if tunnel is configured
          if (tunnelId && this.cloudflareService) {
            const serviceUrl = tunnelServiceUrl ?? def.service;
            log.info({ fqdn: def.fqdn, service: serviceUrl, tunnelId }, 'Adding hostname to Cloudflare tunnel');
            try {
              await this.cloudflareService.addHostname(
                tunnelId,
                def.fqdn,
                serviceUrl,
                undefined,
                { httpHostHeader: def.fqdn },
              );
            } catch (err: any) {
              // If hostname already exists, treat as success (idempotent)
              if (err.message?.includes('already exists')) {
                log.info({ fqdn: def.fqdn }, 'Hostname already exists in tunnel, continuing');
              } else {
                throw err;
              }
            }

            // Create DNS CNAME record pointing hostname to tunnel (best-effort)
            try {
              await this.cloudflareDns.upsertCNAMERecord(def.fqdn, tunnelId);
            } catch (dnsErr) {
              log.warn(
                { fqdn: def.fqdn, tunnelId, error: dnsErr instanceof Error ? dnsErr.message : String(dnsErr) },
                'Failed to create DNS CNAME record for tunnel hostname — ingress rule was added successfully',
              );
            }
          } else {
            log.warn({ stackId, fqdn: def.fqdn }, 'No tunnel configured on environment, skipping Cloudflare API call');
          }

          await this.prisma.stackResource.upsert({
            where: {
              stackId_resourceType_resourceName: {
                stackId,
                resourceType: 'tunnel',
                resourceName: action.resourceName,
              },
            },
            create: {
              stackId,
              resourceType: 'tunnel',
              resourceName: action.resourceName,
              fqdn: def.fqdn,
              externalId: tunnelId,
              externalState: { fqdn: def.fqdn, service: tunnelServiceUrl ?? def.service },
              status: 'active',
            },
            update: {
              fqdn: def.fqdn,
              externalId: tunnelId,
              externalState: { fqdn: def.fqdn, service: tunnelServiceUrl ?? def.service },
              status: 'active',
              error: null,
            },
          });

          result.success = true;
        } else if (action.action === 'remove') {
          // Read externalId to know which tunnel to remove from
          const resource = await this.prisma.stackResource.findFirst({
            where: { stackId, resourceType: 'tunnel', resourceName: action.resourceName },
          });
          const removeTunnelId = resource?.externalId ?? tunnelId;
          const removeFqdn = resource?.fqdn ?? action.resourceName;

          if (removeTunnelId && this.cloudflareService) {
            log.info({ fqdn: removeFqdn, tunnelId: removeTunnelId }, 'Removing hostname from Cloudflare tunnel');
            try {
              await this.cloudflareService.removeHostname(removeTunnelId, removeFqdn);
            } catch (err: any) {
              // If hostname not found, treat as success (already removed)
              if (err.message?.includes('not found')) {
                log.info({ fqdn: removeFqdn }, 'Hostname not found in tunnel, continuing');
              } else {
                throw err;
              }
            }

            // Delete DNS CNAME record for the removed hostname (best-effort)
            try {
              await this.cloudflareDns.deleteCNAMEByHostname(removeFqdn);
            } catch (dnsErr) {
              log.warn(
                { fqdn: removeFqdn, tunnelId: removeTunnelId, error: dnsErr instanceof Error ? dnsErr.message : String(dnsErr) },
                'Failed to delete DNS CNAME record for tunnel hostname — ingress rule was removed successfully',
              );
            }
          }

          await this.prisma.stackResource.deleteMany({
            where: { stackId, resourceType: 'tunnel', resourceName: action.resourceName },
          });
          result.success = true;
        }
      } catch (err: any) {
        log.error({ err, resourceName: action.resourceName }, 'Tunnel reconciliation failed');
        result.error = err.message ?? String(err);
      }

      results.push(result);
      try { onProgress?.(result); } catch {}
    }

    return results;
  }

  // ════════════════════════════════════════════════════
  // validateResourceReferences
  // ════════════════════════════════════════════════════

  /**
   * Check that all services with routing that reference tlsCertificate, dnsRecord,
   * or tunnelIngress by name actually have those names defined in the stack's resource arrays.
   * Returns PlanWarning[] for any missing references.
   */
  validateResourceReferences(
    services: StackServiceDefinition[],
    definitions: ResourceDefinitions,
  ): PlanWarning[] {
    const warnings: PlanWarning[] = [];

    const tlsNames = new Set(definitions.tlsCertificates.map((t) => t.name));
    const dnsNames = new Set(definitions.dnsRecords.map((d) => d.name));
    const tunnelNames = new Set(definitions.tunnelIngress.map((t) => t.name));

    for (const svc of services) {
      const routing = svc.routing;
      if (!routing) continue;

      if (routing.tlsCertificate && !tlsNames.has(routing.tlsCertificate)) {
        warnings.push({
          type: 'resource-reference',
          serviceName: svc.serviceName,
          resourceName: routing.tlsCertificate,
          resourceType: 'tls',
          message: `Service "${svc.serviceName}" references TLS certificate "${routing.tlsCertificate}" which is not defined in the stack's tlsCertificates`,
        });
      }

      if (routing.dnsRecord && !dnsNames.has(routing.dnsRecord)) {
        warnings.push({
          type: 'resource-reference',
          serviceName: svc.serviceName,
          resourceName: routing.dnsRecord,
          resourceType: 'dns',
          message: `Service "${svc.serviceName}" references DNS record "${routing.dnsRecord}" which is not defined in the stack's dnsRecords`,
        });
      }

      if (routing.tunnelIngress && !tunnelNames.has(routing.tunnelIngress)) {
        warnings.push({
          type: 'resource-reference',
          serviceName: svc.serviceName,
          resourceName: routing.tunnelIngress,
          resourceType: 'tunnel',
          message: `Service "${svc.serviceName}" references tunnel ingress "${routing.tunnelIngress}" which is not defined in the stack's tunnelIngress`,
        });
      }
    }

    return warnings;
  }

  // ════════════════════════════════════════════════════
  // destroyAllResources
  // ════════════════════════════════════════════════════

  async destroyAllResources(stackId: string): Promise<void> {
    log.info({ stackId }, 'Destroying all stack resources');

    const resources = await this.prisma.stackResource.findMany({
      where: { stackId },
    });

    // Clean up external resources (non-fatal)
    for (const resource of resources) {
      if (resource.resourceType === 'dns' && resource.externalId) {
        const state = resource.externalState as { zoneId?: string } | null;
        if (state?.zoneId) {
          try {
            await this.cloudflareDns.deleteDNSRecord(state.zoneId, resource.externalId);
            log.info({ resourceName: resource.resourceName, externalId: resource.externalId }, 'Deleted DNS record from Cloudflare');
          } catch (err: any) {
            log.warn({ err, resourceName: resource.resourceName }, 'Failed to delete DNS record from Cloudflare (non-fatal)');
          }
        }
      }
      // TLS certs stay in the store
      // TODO: Tunnel cleanup when tunnel service is ready
    }

    // Delete all DB records
    await this.prisma.stackResource.deleteMany({
      where: { stackId },
    });

    log.info({ stackId, count: resources.length }, 'Stack resources destroyed');
  }
}
