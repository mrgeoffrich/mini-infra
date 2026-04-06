import { PrismaClient } from '@prisma/client';
import { EnvironmentManager } from '../services/environment';
import { DockerExecutorService } from '../services/docker-executor';

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
vi.mock('../services/stacks/seed', () => ({
  seedStacksForEnvironment: vi.fn().mockResolvedValue(undefined),
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
      stack: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      stackService: {
        create: vi.fn().mockResolvedValue({}),
      },
      stackTemplate: {
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
    } as any;

    MockDockerExecutorService.mockImplementation(function() { return mockDockerExecutor; });

    // Restore reconciler mock implementations (cleared by vi.clearAllMocks)
    mockReconcilerApply.mockResolvedValue({
      success: true, stackId: 'stack-1', appliedVersion: 1,
      serviceResults: [{ serviceName: 'haproxy', action: 'create', success: true, duration: 100 }],
      duration: 100,
    });
    mockReconcilerStopStack.mockResolvedValue({ success: true, stoppedContainers: 1 });

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
        networks: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

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
        },
        include: {
          networks: true,
        }
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
