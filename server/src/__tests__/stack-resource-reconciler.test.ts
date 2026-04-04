import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StackResourceReconciler } from '../services/stacks/stack-resource-reconciler';
import type {
  StackTlsCertificate,
  StackDnsRecord,
  StackTunnelIngress,
  ResourceAction,
} from '@mini-infra/types';

// ── Mock factories ──

function makeMockPrisma() {
  return {
    stack: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    environment: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    stackResource: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    tlsCertificate: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  } as any;
}

function makeMockCertLifecycleManager() {
  return {
    issueCertificate: vi.fn().mockResolvedValue({ id: 'cert-new', primaryDomain: 'app.example.com' }),
  } as any;
}

function makeMockCloudflareDns() {
  return {
    upsertARecord: vi.fn().mockResolvedValue({ id: 'dns-rec-1', zone_id: 'zone-1' }),
    deleteDNSRecord: vi.fn().mockResolvedValue(undefined),
    findZoneForHostname: vi.fn().mockResolvedValue({ id: 'zone-1', name: 'example.com' }),
  } as any;
}

// ── Helper: build StackResource DB rows ──

function makeStackResourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sr-1',
    stackId: 'stack-1',
    resourceType: 'tls',
    resourceName: 'app-cert',
    fqdn: 'app.example.com',
    externalId: null,
    externalState: null,
    status: 'active',
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ──

describe('StackResourceReconciler', () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>;
  let mockCertLifecycleManager: ReturnType<typeof makeMockCertLifecycleManager>;
  let mockCloudflareDns: ReturnType<typeof makeMockCloudflareDns>;
  let reconciler: StackResourceReconciler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = makeMockPrisma();
    mockCertLifecycleManager = makeMockCertLifecycleManager();
    mockCloudflareDns = makeMockCloudflareDns();
    reconciler = new StackResourceReconciler(
      mockPrisma,
      mockCertLifecycleManager,
      mockCloudflareDns,
      undefined,
    );
  });

  // ════════════════════════════════════════════════════
  // planResources
  // ════════════════════════════════════════════════════

  describe('planResources', () => {
    it('returns create actions when no current resources exist', () => {
      const defs = {
        tlsCertificates: [{ name: 'app-cert', fqdn: 'app.example.com' }],
        dnsRecords: [{ name: 'app-dns', fqdn: 'app.example.com', recordType: 'A' as const, target: '1.2.3.4' }],
        tunnelIngress: [{ name: 'app-tunnel', fqdn: 'app.example.com', service: 'http://localhost:3000' }],
      };

      const actions = reconciler.planResources(defs, []);

      expect(actions).toHaveLength(3);
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resourceType: 'tls', resourceName: 'app-cert', action: 'create' }),
          expect.objectContaining({ resourceType: 'dns', resourceName: 'app-dns', action: 'create' }),
          expect.objectContaining({ resourceType: 'tunnel', resourceName: 'app-tunnel', action: 'create' }),
        ]),
      );
    });

    it('returns no-op when TLS resource matches', () => {
      const defs = {
        tlsCertificates: [{ name: 'app-cert', fqdn: 'app.example.com' }],
        dnsRecords: [],
        tunnelIngress: [],
      };
      const current = [
        makeStackResourceRow({ resourceType: 'tls', resourceName: 'app-cert', fqdn: 'app.example.com' }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ resourceType: 'tls', resourceName: 'app-cert', action: 'no-op' });
    });

    it('returns update when TLS fqdn differs', () => {
      const defs = {
        tlsCertificates: [{ name: 'app-cert', fqdn: 'new.example.com' }],
        dnsRecords: [],
        tunnelIngress: [],
      };
      const current = [
        makeStackResourceRow({ resourceType: 'tls', resourceName: 'app-cert', fqdn: 'old.example.com' }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        resourceType: 'tls',
        resourceName: 'app-cert',
        action: 'update',
      });
      expect(actions[0].diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'fqdn', old: 'old.example.com', new: 'new.example.com' }),
        ]),
      );
    });

    it('returns remove when resource in DB but not in definitions', () => {
      const defs = {
        tlsCertificates: [],
        dnsRecords: [],
        tunnelIngress: [],
      };
      const current = [
        makeStackResourceRow({ resourceType: 'tls', resourceName: 'old-cert', fqdn: 'old.example.com' }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ resourceType: 'tls', resourceName: 'old-cert', action: 'remove' });
    });

    // DNS-specific diffing
    it('returns no-op for DNS when all fields match (with defaults)', () => {
      const defs = {
        tlsCertificates: [],
        dnsRecords: [{ name: 'app-dns', fqdn: 'app.example.com', recordType: 'A' as const, target: '1.2.3.4' }],
        tunnelIngress: [],
      };
      const current = [
        makeStackResourceRow({
          resourceType: 'dns',
          resourceName: 'app-dns',
          fqdn: 'app.example.com',
          externalState: { target: '1.2.3.4', ttl: 300, proxied: false },
        }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ action: 'no-op' });
    });

    it('returns update for DNS when target differs', () => {
      const defs = {
        tlsCertificates: [],
        dnsRecords: [{ name: 'app-dns', fqdn: 'app.example.com', recordType: 'A' as const, target: '5.6.7.8' }],
        tunnelIngress: [],
      };
      const current = [
        makeStackResourceRow({
          resourceType: 'dns',
          resourceName: 'app-dns',
          fqdn: 'app.example.com',
          externalState: { target: '1.2.3.4', ttl: 300, proxied: false },
        }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ action: 'update' });
      expect(actions[0].diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'target', old: '1.2.3.4', new: '5.6.7.8' }),
        ]),
      );
    });

    // Tunnel-specific diffing
    it('returns no-op for tunnel when fqdn and service match', () => {
      const defs = {
        tlsCertificates: [],
        dnsRecords: [],
        tunnelIngress: [{ name: 'app-tunnel', fqdn: 'app.example.com', service: 'http://localhost:3000' }],
      };
      const current = [
        makeStackResourceRow({
          resourceType: 'tunnel',
          resourceName: 'app-tunnel',
          fqdn: 'app.example.com',
          externalState: { fqdn: 'app.example.com', service: 'http://localhost:3000' },
        }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ action: 'no-op' });
    });

    it('returns update for tunnel when service differs', () => {
      const defs = {
        tlsCertificates: [],
        dnsRecords: [],
        tunnelIngress: [{ name: 'app-tunnel', fqdn: 'app.example.com', service: 'http://localhost:4000' }],
      };
      const current = [
        makeStackResourceRow({
          resourceType: 'tunnel',
          resourceName: 'app-tunnel',
          fqdn: 'app.example.com',
          externalState: { fqdn: 'app.example.com', service: 'http://localhost:3000' },
        }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ action: 'update' });
      expect(actions[0].diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'service', old: 'http://localhost:3000', new: 'http://localhost:4000' }),
        ]),
      );
    });

    it('handles a mix of create, update, remove, and no-op across types', () => {
      const defs = {
        tlsCertificates: [{ name: 'keep-cert', fqdn: 'keep.example.com' }],
        dnsRecords: [{ name: 'new-dns', fqdn: 'new.example.com', recordType: 'A' as const, target: '1.2.3.4' }],
        tunnelIngress: [{ name: 'update-tunnel', fqdn: 'update.example.com', service: 'http://localhost:5000' }],
      };
      const current = [
        makeStackResourceRow({ resourceType: 'tls', resourceName: 'keep-cert', fqdn: 'keep.example.com' }),
        makeStackResourceRow({ resourceType: 'dns', resourceName: 'remove-dns', fqdn: 'old.example.com' }),
        makeStackResourceRow({
          resourceType: 'tunnel',
          resourceName: 'update-tunnel',
          fqdn: 'update.example.com',
          externalState: { fqdn: 'update.example.com', service: 'http://localhost:3000' },
        }),
      ];

      const actions = reconciler.planResources(defs, current);

      expect(actions).toHaveLength(4);
      const byKey = (a: ResourceAction) => `${a.resourceType}:${a.resourceName}`;
      const actionMap = new Map(actions.map((a) => [byKey(a), a]));

      expect(actionMap.get('tls:keep-cert')?.action).toBe('no-op');
      expect(actionMap.get('dns:new-dns')?.action).toBe('create');
      expect(actionMap.get('dns:remove-dns')?.action).toBe('remove');
      expect(actionMap.get('tunnel:update-tunnel')?.action).toBe('update');
    });
  });

  // ════════════════════════════════════════════════════
  // reconcileTls
  // ════════════════════════════════════════════════════

  describe('reconcileTls', () => {
    const stackId = 'stack-1';
    const userId = 'user-1';
    const defs: StackTlsCertificate[] = [{ name: 'app-cert', fqdn: 'app.example.com' }];

    it('provisions a new cert when none exists', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'app-cert', action: 'create' },
      ];

      const results = await reconciler.reconcileTls(actions, stackId, defs, userId);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ resourceType: 'tls', resourceName: 'app-cert', action: 'create', success: true });
      expect(mockCertLifecycleManager.issueCertificate).toHaveBeenCalledWith(
        expect.objectContaining({ primaryDomain: 'app.example.com', domains: ['app.example.com'], userId, deployToHaproxy: false }),
      );
      expect(mockPrisma.stackResource.upsert).toHaveBeenCalled();
    });

    it('reuses an existing ACTIVE cert without deploying to HAProxy', async () => {
      mockPrisma.tlsCertificate.findFirst.mockResolvedValue({
        id: 'cert-existing',
        primaryDomain: 'app.example.com',
        status: 'ACTIVE',
      });

      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'app-cert', action: 'create' },
      ];

      const results = await reconciler.reconcileTls(actions, stackId, defs, userId);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ success: true });
      expect(mockCertLifecycleManager.issueCertificate).not.toHaveBeenCalled();
      expect(mockPrisma.stackResource.upsert).toHaveBeenCalled();
    });

    it('skips no-op actions', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'app-cert', action: 'no-op' },
      ];

      const results = await reconciler.reconcileTls(actions, stackId, defs, userId);

      expect(results).toHaveLength(0);
      expect(mockCertLifecycleManager.issueCertificate).not.toHaveBeenCalled();
      expect(mockPrisma.stackResource.upsert).not.toHaveBeenCalled();
    });

    it('removes TLS resource record only (cert stays in store)', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'app-cert', action: 'remove' },
      ];

      const results = await reconciler.reconcileTls(actions, stackId, defs, userId);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ action: 'remove', success: true });
      expect(mockPrisma.stackResource.deleteMany).toHaveBeenCalledWith({
        where: { stackId, resourceType: 'tls', resourceName: 'app-cert' },
      });
    });

    it('handles provision errors gracefully', async () => {
      mockCertLifecycleManager.issueCertificate.mockRejectedValue(new Error('ACME rate limit'));

      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'app-cert', action: 'create' },
      ];

      const results = await reconciler.reconcileTls(actions, stackId, defs, userId);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ success: false, error: 'ACME rate limit' });
    });
  });

  // ════════════════════════════════════════════════════
  // reconcileDns
  // ════════════════════════════════════════════════════

  describe('reconcileDns', () => {
    const stackId = 'stack-1';
    const defs: StackDnsRecord[] = [
      { name: 'app-dns', fqdn: 'app.example.com', recordType: 'A', target: '1.2.3.4' },
    ];

    it('creates a new A record', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'app-dns', action: 'create' },
      ];

      const results = await reconciler.reconcileDns(actions, stackId, defs);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ resourceType: 'dns', resourceName: 'app-dns', action: 'create', success: true });
      expect(mockCloudflareDns.upsertARecord).toHaveBeenCalledWith('app.example.com', '1.2.3.4', 300, false);
      expect(mockCloudflareDns.findZoneForHostname).toHaveBeenCalledWith('app.example.com');
      expect(mockPrisma.stackResource.upsert).toHaveBeenCalled();
    });

    it('updates an existing record', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'app-dns', action: 'update' },
      ];

      const results = await reconciler.reconcileDns(actions, stackId, defs);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ action: 'update', success: true });
      expect(mockCloudflareDns.upsertARecord).toHaveBeenCalled();
    });

    it('removes a DNS record from Cloudflare and DB', async () => {
      mockPrisma.stackResource.findMany.mockResolvedValue([
        makeStackResourceRow({
          resourceType: 'dns',
          resourceName: 'app-dns',
          externalId: 'dns-rec-1',
          externalState: { target: '1.2.3.4', ttl: 300, proxied: false, zoneId: 'zone-1' },
        }),
      ]);

      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'app-dns', action: 'remove' },
      ];

      const results = await reconciler.reconcileDns(actions, stackId, defs);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ action: 'remove', success: true });
      expect(mockCloudflareDns.deleteDNSRecord).toHaveBeenCalledWith('zone-1', 'dns-rec-1');
      expect(mockPrisma.stackResource.deleteMany).toHaveBeenCalled();
    });

    it('skips no-op actions', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'app-dns', action: 'no-op' },
      ];

      const results = await reconciler.reconcileDns(actions, stackId, defs);

      expect(results).toHaveLength(0);
    });

    it('handles Cloudflare API errors gracefully', async () => {
      mockCloudflareDns.upsertARecord.mockRejectedValue(new Error('Cloudflare API error'));

      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'app-dns', action: 'create' },
      ];

      const results = await reconciler.reconcileDns(actions, stackId, defs);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ success: false, error: 'Cloudflare API error' });
    });
  });

  // ════════════════════════════════════════════════════
  // reconcileTunnel
  // ════════════════════════════════════════════════════

  describe('reconcileTunnel', () => {
    const stackId = 'stack-1';
    const defs: StackTunnelIngress[] = [
      { name: 'app-tunnel', fqdn: 'app.example.com', service: 'http://localhost:3000' },
    ];

    it('creates a tunnel ingress resource record', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'tunnel', resourceName: 'app-tunnel', action: 'create' },
      ];

      const results = await reconciler.reconcileTunnel(actions, stackId, defs);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ resourceType: 'tunnel', resourceName: 'app-tunnel', action: 'create', success: true });
      expect(mockPrisma.stackResource.upsert).toHaveBeenCalled();
      // Verify externalState was saved
      const upsertCall = mockPrisma.stackResource.upsert.mock.calls[0][0];
      expect(upsertCall.create.externalState).toEqual({ fqdn: 'app.example.com', service: 'http://localhost:3000' });
    });

    it('removes a tunnel ingress resource record', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'tunnel', resourceName: 'app-tunnel', action: 'remove' },
      ];

      const results = await reconciler.reconcileTunnel(actions, stackId, defs);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ action: 'remove', success: true });
      expect(mockPrisma.stackResource.deleteMany).toHaveBeenCalledWith({
        where: { stackId, resourceType: 'tunnel', resourceName: 'app-tunnel' },
      });
    });

    it('skips no-op actions', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'tunnel', resourceName: 'app-tunnel', action: 'no-op' },
      ];

      const results = await reconciler.reconcileTunnel(actions, stackId, defs);

      expect(results).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════
  // validateResourceReferences
  // ════════════════════════════════════════════════════

  describe('validateResourceReferences', () => {
    it('returns warnings for services referencing non-existent resources', () => {
      const services = [
        {
          serviceName: 'web-app',
          serviceType: 'StatelessWeb' as const,
          dockerImage: 'myapp/web',
          dockerTag: '1.0.0',
          containerConfig: {},
          dependsOn: [],
          order: 1,
          routing: {
            hostname: 'app.example.com',
            listeningPort: 3000,
            tlsCertificate: 'missing-cert',
            dnsRecord: 'missing-dns',
            tunnelIngress: 'missing-tunnel',
          },
        },
      ];

      const definitions = {
        tlsCertificates: [],
        dnsRecords: [],
        tunnelIngress: [],
      };

      const warnings = reconciler.validateResourceReferences(services, definitions);

      expect(warnings).toHaveLength(3);
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'resource-reference',
            serviceName: 'web-app',
            resourceName: 'missing-cert',
            resourceType: 'tls',
          }),
          expect.objectContaining({
            type: 'resource-reference',
            serviceName: 'web-app',
            resourceName: 'missing-dns',
            resourceType: 'dns',
          }),
          expect.objectContaining({
            type: 'resource-reference',
            serviceName: 'web-app',
            resourceName: 'missing-tunnel',
            resourceType: 'tunnel',
          }),
        ]),
      );
    });

    it('returns no warnings for valid references', () => {
      const services = [
        {
          serviceName: 'web-app',
          serviceType: 'StatelessWeb' as const,
          dockerImage: 'myapp/web',
          dockerTag: '1.0.0',
          containerConfig: {},
          dependsOn: [],
          order: 1,
          routing: {
            hostname: 'app.example.com',
            listeningPort: 3000,
            tlsCertificate: 'app-cert',
            dnsRecord: 'app-dns',
            tunnelIngress: 'app-tunnel',
          },
        },
      ];

      const definitions = {
        tlsCertificates: [{ name: 'app-cert', fqdn: 'app.example.com' }],
        dnsRecords: [{ name: 'app-dns', fqdn: 'app.example.com', recordType: 'A' as const, target: '1.2.3.4' }],
        tunnelIngress: [{ name: 'app-tunnel', fqdn: 'app.example.com', service: 'http://localhost:3000' }],
      };

      const warnings = reconciler.validateResourceReferences(services, definitions);

      expect(warnings).toHaveLength(0);
    });

    it('returns no warnings for services without routing', () => {
      const services = [
        {
          serviceName: 'redis',
          serviceType: 'Stateful' as const,
          dockerImage: 'redis',
          dockerTag: '7.0',
          containerConfig: {},
          dependsOn: [],
          order: 1,
        },
      ];

      const definitions = {
        tlsCertificates: [],
        dnsRecords: [],
        tunnelIngress: [],
      };

      const warnings = reconciler.validateResourceReferences(services, definitions);

      expect(warnings).toHaveLength(0);
    });

    it('returns no warnings when routing has no resource references', () => {
      const services = [
        {
          serviceName: 'web-app',
          serviceType: 'StatelessWeb' as const,
          dockerImage: 'myapp/web',
          dockerTag: '1.0.0',
          containerConfig: {},
          dependsOn: [],
          order: 1,
          routing: {
            hostname: 'app.example.com',
            listeningPort: 3000,
          },
        },
      ];

      const definitions = {
        tlsCertificates: [],
        dnsRecords: [],
        tunnelIngress: [],
      };

      const warnings = reconciler.validateResourceReferences(services, definitions);

      expect(warnings).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════
  // destroyAllResources
  // ════════════════════════════════════════════════════

  describe('destroyAllResources', () => {
    const stackId = 'stack-1';

    it('cleans up DNS records from Cloudflare and deletes all DB records', async () => {
      mockPrisma.stackResource.findMany.mockResolvedValue([
        makeStackResourceRow({
          resourceType: 'dns',
          resourceName: 'dns-1',
          externalId: 'cf-dns-1',
          externalState: { target: '1.2.3.4', ttl: 300, proxied: false, zoneId: 'zone-1' },
        }),
        makeStackResourceRow({
          resourceType: 'tls',
          resourceName: 'tls-1',
          externalId: 'cert-1',
        }),
        makeStackResourceRow({
          resourceType: 'tunnel',
          resourceName: 'tunnel-1',
        }),
      ]);

      await reconciler.destroyAllResources(stackId);

      // Should delete DNS from Cloudflare
      expect(mockCloudflareDns.deleteDNSRecord).toHaveBeenCalledWith('zone-1', 'cf-dns-1');
      // Should delete all DB records
      expect(mockPrisma.stackResource.deleteMany).toHaveBeenCalledWith({
        where: { stackId },
      });
    });

    it('continues even if Cloudflare cleanup fails', async () => {
      mockPrisma.stackResource.findMany.mockResolvedValue([
        makeStackResourceRow({
          resourceType: 'dns',
          resourceName: 'dns-1',
          externalId: 'cf-dns-1',
          externalState: { target: '1.2.3.4', ttl: 300, proxied: false, zoneId: 'zone-1' },
        }),
      ]);
      mockCloudflareDns.deleteDNSRecord.mockRejectedValue(new Error('CF error'));

      // Should not throw
      await reconciler.destroyAllResources(stackId);

      // Should still delete DB records
      expect(mockPrisma.stackResource.deleteMany).toHaveBeenCalledWith({
        where: { stackId },
      });
    });

    it('handles stacks with no resources', async () => {
      mockPrisma.stackResource.findMany.mockResolvedValue([]);

      await reconciler.destroyAllResources(stackId);

      expect(mockCloudflareDns.deleteDNSRecord).not.toHaveBeenCalled();
      expect(mockPrisma.stackResource.deleteMany).toHaveBeenCalledWith({
        where: { stackId },
      });
    });
  });
});
