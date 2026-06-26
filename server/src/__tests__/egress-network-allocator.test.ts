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
  infraResourceFindFirst: unknown;
}> = {}): Mocked<PrismaClient> {
  return {
    infraResource: {
      findFirst: vi.fn().mockResolvedValue(overrides.infraResourceFindFirst ?? null),
    },
  } as unknown as Mocked<PrismaClient>;
}

describe('EgressNetworkAllocator', () => {
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
