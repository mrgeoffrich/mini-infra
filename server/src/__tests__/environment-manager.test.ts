import { PrismaClient } from "../generated/prisma/client";
import { EnvironmentManager } from '../services/environment';
import { DockerExecutorService } from '../services/docker-executor';

// Mock prisma module so docker-executor/index.ts doesn't try to resolve DATABASE_URL at import time
vi.mock('../lib/prisma', () => ({ default: {} }));

// Mock dependencies
vi.mock('../services/docker-executor');
vi.mock('../services/user-events', () => {
  const MockUserEventService = class {
    createEvent = vi.fn().mockResolvedValue({ id: 'user-event-1' });
    updateEvent = vi.fn().mockResolvedValue({});
    appendLogs = vi.fn().mockResolvedValue({});
  };
  return { UserEventService: MockUserEventService };
});

const mockReconcilerApply = vi.fn();
const mockReconcilerStopStack = vi.fn();
vi.mock('../services/stacks/stack-reconciler', () => ({
  StackReconciler: function() {
    return {
      apply: mockReconcilerApply,
      stopStack: mockReconcilerStopStack,
    };
  },
}));
vi.mock('../services/stacks/stack-routing-manager', () => ({
  StackRoutingManager: vi.fn(),
}));
vi.mock('../services/haproxy', () => ({
  HAProxyFrontendManager: vi.fn(),
}));

// Mock DockerService singleton (used by EgressNetworkAllocator)
vi.mock('../services/docker', () => ({
  default: {
    getInstance: vi.fn(() => ({
      isConnected: vi.fn().mockReturnValue(false),
      listNetworks: vi.fn().mockResolvedValue([]),
    })),
  },
}));

// Mock EgressNetworkAllocator
const mockAllocateSubnet = vi.fn().mockResolvedValue({ subnet: '172.30.0.0/24', gateway: '172.30.0.1' });
vi.mock('../services/egress/egress-network-allocator', () => ({
  EgressNetworkAllocator: function() {
    return {
      allocateSubnet: mockAllocateSubnet,
      allocateGatewayIp: vi.fn().mockResolvedValue('172.30.0.2'),
    };
  },
}));

// Mock EnvFirewallManager singleton accessor
const mockApplyEnv = vi.fn().mockResolvedValue(undefined);
const mockRemoveEnv = vi.fn().mockResolvedValue(undefined);
const mockGetEnvFirewallManager = vi.fn(() => ({
  applyEnv: mockApplyEnv,
  removeEnv: mockRemoveEnv,
}));
vi.mock('../services/egress', () => ({
  getEnvFirewallManager: () => mockGetEnvFirewallManager(),
}));

const MockDockerExecutorService = DockerExecutorService as MockedClass<typeof DockerExecutorService>;

describe('EnvironmentManager', () => {
  let environmentManager: EnvironmentManager;
  let mockPrisma: Mocked<PrismaClient>;
  let mockDockerExecutor: Mocked<DockerExecutorService>;

  beforeEach(() => {
    // Reset singletons
    (EnvironmentManager as any).instance = undefined;

    // Create mock Prisma client
    mockPrisma = {
      environment: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      environmentNetwork: {
        upsert: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      infraResource: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'infra-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      stack: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'stack-1', services: [] }),
        update: vi.fn().mockResolvedValue({}),
      },
      stackService: {
        create: vi.fn().mockResolvedValue({}),
      },
      stackTemplate: {
        findUnique: vi.fn().mockResolvedValue(null), // No egress template by default
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({}),
      },
    } as any;

    mockDockerExecutor = {
      initialize: vi.fn().mockResolvedValue(undefined),
      networkExists: vi.fn().mockResolvedValue(false),
      volumeExists: vi.fn().mockResolvedValue(false),
      createNetwork: vi.fn().mockResolvedValue(undefined),
      createVolume: vi.fn().mockResolvedValue(undefined),
      getDockerClient: vi.fn().mockReturnValue({
        listContainers: vi.fn().mockResolvedValue([]),
        getContainer: vi.fn().mockReturnValue({ id: 'c-1' }),
        getNetwork: vi.fn().mockReturnValue({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    } as any;

    MockDockerExecutorService.mockImplementation(function() { return mockDockerExecutor; });

    // Restore reconciler mock implementations (cleared by vi.clearAllMocks)
    mockReconcilerApply.mockResolvedValue({
      success: true, stackId: 'stack-1', appliedVersion: 1,
      serviceResults: [{ serviceName: 'egress-gateway', action: 'create', success: true, duration: 100 }],
      duration: 100,
    });
    mockReconcilerStopStack.mockResolvedValue({ success: true, stoppedContainers: 1 });
    mockAllocateSubnet.mockResolvedValue({ subnet: '172.30.0.0/24', gateway: '172.30.0.1' });

    environmentManager = EnvironmentManager.getInstance(mockPrisma);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const instance1 = EnvironmentManager.getInstance(mockPrisma);
      const instance2 = EnvironmentManager.getInstance(mockPrisma);

      expect(instance1).toBe(instance2);
    });
  });

  describe('createEnvironment', () => {
    it('should create environment successfully', async () => {
      const createdEnvData = {
        id: 'env-1',
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction',
        networkType: 'local',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const fetchedEnvData = {
        ...createdEnvData,
        networks: [],
      };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);
      mockPrisma.environmentNetwork.upsert.mockResolvedValue({} as any);

      const request = {
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction' as const
      };

      const result = await environmentManager.createEnvironment(request);

      expect(result).toBeDefined();
      expect(result.name).toBe('test-env');
      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: 'Test environment',
          type: 'nonproduction',
          networkType: 'local',
        },
      });
    });

    it('should create environment with specified networkType', async () => {
      const createdEnvData = {
        id: 'env-1',
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction',
        networkType: 'internet',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const fetchedEnvData = {
        ...createdEnvData,
        networks: [],
      };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);
      mockPrisma.environmentNetwork.upsert.mockResolvedValue({} as any);

      const request = {
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction' as const,
        networkType: 'internet' as const
      };

      await environmentManager.createEnvironment(request);

      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: 'Test environment',
          type: 'nonproduction',
          networkType: 'internet',
        },
      });
    });

    it('should default networkType to local if not specified', async () => {
      const createdEnvData = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const fetchedEnvData = {
        ...createdEnvData,
        networks: [],
      };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);
      mockPrisma.environmentNetwork.upsert.mockResolvedValue({} as any);

      const request = {
        name: 'test-env',
        type: 'nonproduction' as const
        // networkType is omitted, should default to 'local'
      };

      await environmentManager.createEnvironment(request);

      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: undefined,
          type: 'nonproduction',
          networkType: 'local',
        },
      });
    });
  });

  describe('getEnvironmentById', () => {
    it('should return environment when found', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        networks: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);

      const result = await environmentManager.getEnvironmentById('env-1');

      expect(result).toBeDefined();
      expect(result!.id).toBe('env-1');
      expect(result!.name).toBe('test-env');
      expect(mockPrisma.environment.findUnique).toHaveBeenCalledWith({
        where: { id: 'env-1' },
        include: {
          networks: true,
          _count: {
            select: {
              stacks: { where: { template: { source: 'user' } } },
            },
          },
          stacks: {
            where: { template: { source: 'system' }, status: { notIn: ['removed', 'undeployed'] } },
            select: { id: true },
          },
        }
      });
    });

    it('should return null when environment not found', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(null);

      const result = await environmentManager.getEnvironmentById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listEnvironments', () => {
    it('should list environments with pagination', async () => {
      const mockEnvironments = [
        {
          id: 'env-1',
          name: 'env-1',
          type: 'production',
          networkType: 'local',
          networks: [],
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ];

      mockPrisma.environment.findMany.mockResolvedValue(mockEnvironments as any);
      mockPrisma.environment.count.mockResolvedValue(1);

      const result = await environmentManager.listEnvironments('production', 1, 10);

      expect(result.total).toBe(1);
      expect(result.environments).toHaveLength(1);
      expect(mockPrisma.environment.findMany).toHaveBeenCalledWith({
        where: { type: 'production' },
        include: {
          networks: true,
          _count: {
            select: {
              stacks: { where: { template: { source: 'user' } } },
            },
          },
          stacks: {
            where: { template: { source: 'system' }, status: { notIn: ['removed', 'undeployed'] } },
            select: { id: true },
          },
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' }
      });
    });
  });

  describe('updateEnvironment', () => {
    it('should update environment successfully', async () => {
      const mockUpdatedEnvironment = {
        id: 'env-1',
        name: 'updated-env',
        description: 'Updated description',
        type: 'production',
        networkType: 'local',
        egressFirewallEnabled: false,
        networks: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: false, name: 'updated-env' } as any);
      mockPrisma.environment.update.mockResolvedValue(mockUpdatedEnvironment as any);

      const request = {
        name: 'updated-env',
        description: 'Updated description',
        type: 'production' as const
      };

      const result = await environmentManager.updateEnvironment('env-1', request);

      expect(result).toBeDefined();
      expect(result!.name).toBe('updated-env');
      expect(mockPrisma.environment.update).toHaveBeenCalledWith({
        where: { id: 'env-1' },
        data: {
          description: 'Updated description',
          type: 'production',
          networkType: undefined,
          tunnelId: undefined,
          tunnelServiceUrl: undefined,
          egressFirewallEnabled: undefined,
        },
        include: {
          networks: true,
          _count: {
            select: {
              stacks: { where: { template: { source: 'user' } } },
            },
          },
          stacks: {
            where: { template: { source: 'system' }, status: { notIn: ['removed', 'undeployed'] } },
            select: { id: true },
          },
        }
      });
    });

    describe('egressFirewallEnabled transitions', () => {
      const baseEnvRow = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        networks: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      it('should call applyEnv with observe mode when toggled false→true', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: false, name: 'test-env' } as any);
        mockPrisma.environment.update.mockResolvedValue({ ...baseEnvRow, egressFirewallEnabled: true } as any);

        await environmentManager.updateEnvironment('env-1', { egressFirewallEnabled: true });

        expect(mockApplyEnv).toHaveBeenCalledWith('env-1', 'observe');
        expect(mockRemoveEnv).not.toHaveBeenCalled();
      });

      it('should call removeEnv when toggled true→false', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: true, name: 'test-env' } as any);
        mockPrisma.environment.update.mockResolvedValue({ ...baseEnvRow, egressFirewallEnabled: false } as any);

        await environmentManager.updateEnvironment('env-1', { egressFirewallEnabled: false });

        expect(mockRemoveEnv).toHaveBeenCalledWith('env-1', 'test-env');
        expect(mockApplyEnv).not.toHaveBeenCalled();
      });

      it('should not call applyEnv or removeEnv when value is unchanged (true→true)', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: true, name: 'test-env' } as any);
        mockPrisma.environment.update.mockResolvedValue({ ...baseEnvRow, egressFirewallEnabled: true } as any);

        await environmentManager.updateEnvironment('env-1', { egressFirewallEnabled: true });

        expect(mockApplyEnv).not.toHaveBeenCalled();
        expect(mockRemoveEnv).not.toHaveBeenCalled();
      });

      it('should not call applyEnv or removeEnv when egressFirewallEnabled is omitted from the request', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: false, name: 'test-env' } as any);
        mockPrisma.environment.update.mockResolvedValue({ ...baseEnvRow, egressFirewallEnabled: false } as any);

        await environmentManager.updateEnvironment('env-1', { description: 'just changing desc' });

        expect(mockApplyEnv).not.toHaveBeenCalled();
        expect(mockRemoveEnv).not.toHaveBeenCalled();
      });

      it('should not throw when applyEnv fails (best-effort, DB is authoritative)', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: false, name: 'test-env' } as any);
        mockPrisma.environment.update.mockResolvedValue({ ...baseEnvRow, egressFirewallEnabled: true } as any);
        mockApplyEnv.mockRejectedValueOnce(new Error('fw-agent unreachable'));

        const result = await environmentManager.updateEnvironment('env-1', { egressFirewallEnabled: true });

        expect(result).not.toBeNull();
        expect(mockApplyEnv).toHaveBeenCalledWith('env-1', 'observe');
      });

      it('should skip the agent call gracefully when EnvFirewallManager is not initialised', async () => {
        mockGetEnvFirewallManager.mockReturnValueOnce(null as any);
        mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: false, name: 'test-env' } as any);
        mockPrisma.environment.update.mockResolvedValue({ ...baseEnvRow, egressFirewallEnabled: true } as any);

        const result = await environmentManager.updateEnvironment('env-1', { egressFirewallEnabled: true });

        expect(result).not.toBeNull();
        expect(mockApplyEnv).not.toHaveBeenCalled();
        expect(mockRemoveEnv).not.toHaveBeenCalled();
      });
    });
  });

  describe('deleteEnvironment', () => {
    it('should delete environment successfully when found', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        networks: [],
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);

      const result = await environmentManager.deleteEnvironment('env-1');

      expect(result).toBe(true);
      expect(mockPrisma.environment.delete).toHaveBeenCalledWith({
        where: { id: 'env-1' }
      });
    });

    it('should return false for non-existent environment', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(null);

      const result = await environmentManager.deleteEnvironment('non-existent');

      expect(result).toBe(false);
    });
  });
});
