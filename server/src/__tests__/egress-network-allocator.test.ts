import { EgressNetworkAllocator } from '../services/egress/egress-network-allocator';
import { PrismaClient } from '../generated/prisma/client';

// Mock DockerService so tests don't need a real Docker daemon
vi.mock('../services/docker', () => ({
  default: {
    getInstance: vi.fn(() => ({
      isConnected: vi.fn().mockReturnValue(false),
      listNetworks: vi.fn().mockResolvedValue([]),
    })),
  },
}));

function makeMockPrisma(overrides: Partial<{
  infraResourceFindMany: unknown;
  infraResourceFindFirst: unknown;
}> = {}): Mocked<PrismaClient> {
  return {
    infraResource: {
      findMany: vi.fn().mockResolvedValue(overrides.infraResourceFindMany ?? []),
      findFirst: vi.fn().mockResolvedValue(overrides.infraResourceFindFirst ?? null),
    },
  } as unknown as Mocked<PrismaClient>;
}

describe('EgressNetworkAllocator', () => {
  beforeEach(() => {
    // Clear env var override between tests
    delete process.env['MINI_INFRA_EGRESS_POOL_CIDR'];
  });

  describe('allocateSubnet', () => {
    it('allocates the first /24 from the default pool when no subnets are in use', async () => {
      const prisma = makeMockPrisma();
      const allocator = new EgressNetworkAllocator(prisma);

      const result = await allocator.allocateSubnet();

      expect(result.subnet).toBe('172.30.0.0/24');
      expect(result.gateway).toBe('172.30.0.1');
    });

    it('skips subnets already stored in InfraResource.metadata', async () => {
      // Slots 0, 1 are taken; should return slot 2
      const prisma = makeMockPrisma({
        infraResourceFindMany: [
          { metadata: { subnet: '172.30.0.0/24', gateway: '172.30.0.1' } },
          { metadata: { subnet: '172.30.1.0/24', gateway: '172.30.1.1' } },
        ],
      });
      const allocator = new EgressNetworkAllocator(prisma);

      const result = await allocator.allocateSubnet();

      expect(result.subnet).toBe('172.30.2.0/24');
      expect(result.gateway).toBe('172.30.2.1');
    });

    it('skips subnets in use by Docker when Docker is connected', async () => {
      const { default: DockerService } = await import('../services/docker');
      vi.mocked(DockerService.getInstance).mockReturnValueOnce({
        isConnected: vi.fn().mockReturnValue(true),
        listNetworks: vi.fn().mockResolvedValue([
          { ipam: { config: [{ subnet: '172.30.0.0/24' }] } },
          { ipam: { config: [{ subnet: '172.30.1.0/24' }] } },
        ]),
      } as any);

      const prisma = makeMockPrisma();
      const allocator = new EgressNetworkAllocator(prisma);

      const result = await allocator.allocateSubnet();

      expect(result.subnet).toBe('172.30.2.0/24');
    });

    it('ignores IPv6 entries in Docker network list', async () => {
      const { default: DockerService } = await import('../services/docker');
      vi.mocked(DockerService.getInstance).mockReturnValueOnce({
        isConnected: vi.fn().mockReturnValue(true),
        listNetworks: vi.fn().mockResolvedValue([
          { ipam: { config: [{ subnet: 'fd00::/64' }] } },   // IPv6 - should be ignored
          { ipam: { config: [{ subnet: '172.30.0.0/24' }] } }, // IPv4 - should be counted
        ]),
      } as any);

      const prisma = makeMockPrisma();
      const allocator = new EgressNetworkAllocator(prisma);

      // IPv6 entry ignored, only 172.30.0.0/24 taken → next is 172.30.1.0/24
      const result = await allocator.allocateSubnet();

      expect(result.subnet).toBe('172.30.1.0/24');
    });

    it('throws when the pool is exhausted', async () => {
      // Fill all 256 slots of 172.30.0.0/16
      const allSubnets = Array.from({ length: 256 }, (_, i) => ({
        metadata: { subnet: `172.30.${i}.0/24` },
      }));
      const prisma = makeMockPrisma({ infraResourceFindMany: allSubnets });
      const allocator = new EgressNetworkAllocator(prisma);

      await expect(allocator.allocateSubnet()).rejects.toThrow(/pool exhausted/i);
    });

    it('respects MINI_INFRA_EGRESS_POOL_CIDR env var', async () => {
      process.env['MINI_INFRA_EGRESS_POOL_CIDR'] = '10.100.0.0/16';

      const prisma = makeMockPrisma();
      const allocator = new EgressNetworkAllocator(prisma);

      const result = await allocator.allocateSubnet();

      expect(result.subnet).toBe('10.100.0.0/24');
      expect(result.gateway).toBe('10.100.0.1');
    });

    it('ignores InfraResource entries with no metadata.subnet', async () => {
      const prisma = makeMockPrisma({
        infraResourceFindMany: [
          { metadata: null },
          { metadata: {} },
          { metadata: { someOtherField: 'value' } },
        ],
      });
      const allocator = new EgressNetworkAllocator(prisma);

      // All entries have no subnet, so slot 0 should be available
      const result = await allocator.allocateSubnet();
      expect(result.subnet).toBe('172.30.0.0/24');
    });
  });

  describe('allocateGatewayIp', () => {
    it('returns .2 in the subnet when no containers are connected', async () => {
      const { default: DockerService } = await import('../services/docker');
      vi.mocked(DockerService.getInstance).mockReturnValueOnce({
        isConnected: vi.fn().mockReturnValue(true),
        listNetworks: vi.fn().mockResolvedValue([
          {
            name: 'staging-egress',
            ipam: { config: [{ subnet: '172.30.5.0/24' }] },
            containers: [],
          },
        ]),
      } as any);

      const prisma = makeMockPrisma();
      const allocator = new EgressNetworkAllocator(prisma);

      const ip = await allocator.allocateGatewayIp('staging-egress');

      expect(ip).toBe('172.30.5.2');
    });

    it('skips .2 if already used and falls through to .3', async () => {
      const { default: DockerService } = await import('../services/docker');
      vi.mocked(DockerService.getInstance).mockReturnValueOnce({
        isConnected: vi.fn().mockReturnValue(true),
        listNetworks: vi.fn().mockResolvedValue([
          {
            name: 'staging-egress',
            ipam: { config: [{ subnet: '172.30.5.0/24' }] },
            containers: [
              { ipv4Address: '172.30.5.2' },
            ],
          },
        ]),
      } as any);

      const prisma = makeMockPrisma();
      const allocator = new EgressNetworkAllocator(prisma);

      const ip = await allocator.allocateGatewayIp('staging-egress');

      expect(ip).toBe('172.30.5.3');
    });

    it('falls back to InfraResource.metadata.subnet when Docker is not connected', async () => {
      // Docker reports not connected
      const { default: DockerService } = await import('../services/docker');
      vi.mocked(DockerService.getInstance).mockReturnValueOnce({
        isConnected: vi.fn().mockReturnValue(false),
        listNetworks: vi.fn().mockResolvedValue([]),
      } as any);

      const prisma = makeMockPrisma({
        infraResourceFindFirst: { metadata: { subnet: '172.30.7.0/24' } },
      });
      const allocator = new EgressNetworkAllocator(prisma);

      const ip = await allocator.allocateGatewayIp('staging-egress');

      expect(ip).toBe('172.30.7.2');
    });

    it('throws when no subnet can be determined for the network', async () => {
      const prisma = makeMockPrisma({ infraResourceFindFirst: null });
      const allocator = new EgressNetworkAllocator(prisma);

      await expect(allocator.allocateGatewayIp('nonexistent-network')).rejects.toThrow(/no subnet found/i);
    });
  });
});
