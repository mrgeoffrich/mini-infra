import { PrismaClient, Prisma } from "../generated/prisma/client";
import { EnvironmentManager } from '../services/environment';
import { DockerExecutorService } from '../services/docker-executor';
import DockerService from '../services/docker';
import { ConflictError, NotFoundError } from '../lib/errors';

/** Constructs a real Prisma error the same way the client would, for a given error code. */
function prismaKnownRequestError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

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
vi.mock('../services/egress/egress-network-allocator', () => ({
  EgressNetworkAllocator: function() {
    return {
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
  // Reassignable per-test so individual tests can override the network
  // inspect behaviour (e.g. to simulate a slow/hanging Docker call) that
  // NetworkManager (services/networks/) reads via getDockerClient().getNetwork(...).inspect().
  let mockNetworkInspect: ReturnType<typeof vi.fn>;

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
      infraResource: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'infra-1' }),
        update: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      managedNetwork: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
      userEvent: {
        update: vi.fn().mockResolvedValue({}),
      },
    } as any;

    // NetworkManager (services/networks/) talks to the raw Docker client
    // obtained via dockerExecutor.getDockerClient() — not the old
    // dockerExecutor.networkExists()/createNetwork() passthroughs, which
    // provisionEgressGateway no longer calls.
    mockNetworkInspect = vi.fn().mockResolvedValue({
      IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] },
    });

    mockDockerExecutor = {
      initialize: vi.fn().mockResolvedValue(undefined),
      volumeExists: vi.fn().mockResolvedValue(false),
      createVolume: vi.fn().mockResolvedValue(undefined),
      getDockerClient: vi.fn().mockReturnValue({
        listContainers: vi.fn().mockResolvedValue([]),
        getContainer: vi.fn().mockReturnValue({ id: 'c-1' }),
        // Used by NetworkManager.removeByOwner()'s label-filtered lookup
        // (deleteEnvironment). Empty by default — tests that exercise
        // network removal override this per-case.
        listNetworks: vi.fn().mockResolvedValue([]),
        getNetwork: vi.fn().mockReturnValue({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          inspect: mockNetworkInspect,
          remove: vi.fn().mockResolvedValue(undefined),
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
      const fetchedEnvData = { ...createdEnvData };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);

      const request = {
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction' as const
      };

      const result = await environmentManager.createEnvironment(request);

      expect(result).toBeDefined();
      expect(result.environment.name).toBe('test-env');
      expect(result.userEventId).toBe('user-event-1');
      expect(result.provisioning).toBeInstanceOf(Promise);
      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: 'Test environment',
          type: 'nonproduction',
          networkType: 'local',
        },
      });
      // Wait for background provisioning to settle so it doesn't bleed into other tests.
      await result.provisioning;
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
      const fetchedEnvData = { ...createdEnvData };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);

      const request = {
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction' as const,
        networkType: 'internet' as const
      };

      const result = await environmentManager.createEnvironment(request);

      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: 'Test environment',
          type: 'nonproduction',
          networkType: 'internet',
        },
      });
      await result.provisioning;
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
      const fetchedEnvData = { ...createdEnvData };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);

      const request = {
        name: 'test-env',
        type: 'nonproduction' as const
        // networkType is omitted, should default to 'local'
      };

      const result = await environmentManager.createEnvironment(request);

      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: undefined,
          type: 'nonproduction',
          networkType: 'local',
        },
      });
      await result.provisioning;
    });

    it('should return before background provisioning completes', async () => {
      const createdEnvData = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const fetchedEnvData = { ...createdEnvData };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);

      // Make the egress provisioning step (network inspect, used by
      // NetworkManager.ensure()/inspect() to read Docker's assigned subnet)
      // hang for a long time — long enough that any sync `await` would time
      // out the test.
      let resolveNetworkInspect!: (value: unknown) => void;
      const blockingInspect = new Promise((resolve) => { resolveNetworkInspect = resolve; });
      mockNetworkInspect.mockReturnValue(blockingInspect);

      const request = { name: 'test-env', type: 'nonproduction' as const };

      // If createEnvironment awaited provisioning, this would hang. The
      // 1-second timeout ensures the test fails fast if provisioning blocks.
      const racePromise = Promise.race([
        environmentManager.createEnvironment(request),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('createEnvironment did not return promptly')), 1000)),
      ]);

      const result = await racePromise as Awaited<ReturnType<typeof environmentManager.createEnvironment>>;

      expect(result.environment.name).toBe('test-env');
      expect(result.userEventId).toBe('user-event-1');

      // Release the blocked provisioning so the background work can settle.
      resolveNetworkInspect({ IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] } });
      await result.provisioning;
    });

    it('should surface async provisioning failure on the UserEvent, not the HTTP response', async () => {
      const createdEnvData = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const fetchedEnvData = { ...createdEnvData };

      mockPrisma.environment.create.mockResolvedValue(createdEnvData as any);
      mockPrisma.environment.findUnique.mockResolvedValue(fetchedEnvData as any);

      // Make an egress provisioning step throw — provisionEgressGateway swallows
      // it, but the UserEvent should still finalise (env is usable) with a
      // warning entry in the logs. The HTTP response is unaffected.
      // `environment.update` (persisting egressGatewayIp) only fires from the
      // background provisioning path — not from the synchronous
      // getEnvironmentById() call `createEnvironment()` makes before
      // returning — so rejecting it here can't bleed into the synchronous
      // assertions below.
      mockPrisma.environment.update.mockRejectedValueOnce(new Error('docker unavailable'));

      const request = { name: 'test-env', type: 'nonproduction' as const };

      // createEnvironment must not throw even though provisioning will fail.
      const result = await environmentManager.createEnvironment(request);
      expect(result.environment.name).toBe('test-env');

      // Background provisioning resolves (provisionEgressGateway swallows internal errors).
      await result.provisioning;

      // The UserEvent should have received warning logs about the failure.
      const userEventService = (environmentManager as any).userEventService;
      expect(userEventService.appendLogs).toHaveBeenCalledWith(
        'user-event-1',
        expect.stringContaining('Egress gateway provisioning failed'),
      );
    });

    it('should throw a ConflictError (ENVIRONMENT_NAME_EXISTS) when the name is already taken (Prisma P2002)', async () => {
      // `Environment.name` is `@unique` — a real duplicate-name create hits
      // this Prisma error code. The service must attribute it directly
      // instead of letting the raw Prisma error (and its English message)
      // bubble up for the route to string-match.
      mockPrisma.environment.create.mockRejectedValue(
        prismaKnownRequestError('P2002', 'Unique constraint failed on the fields: (`name`)'),
      );

      const request = { name: 'existing-env', type: 'nonproduction' as const };

      let caught: unknown;
      try {
        await environmentManager.createEnvironment(request);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictError);
      expect(caught).toMatchObject({
        statusCode: 409,
        code: 'ENVIRONMENT_NAME_EXISTS',
        resource: { type: 'environment', name: 'existing-env' },
        message: expect.stringContaining('existing-env'),
      });
    });

    it('should rethrow non-P2002 Prisma errors from create() unchanged', async () => {
      const dbError = prismaKnownRequestError('P2003', 'Foreign key constraint failed');
      mockPrisma.environment.create.mockRejectedValue(dbError);

      const request = { name: 'test-env', type: 'nonproduction' as const };

      await expect(environmentManager.createEnvironment(request)).rejects.toBe(dbError);
    });
  });

  describe('getEnvironmentById', () => {
    it('should return environment when found', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
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
          _count: {
            select: {
              stacks: { where: { template: { source: 'user' } } },
            },
          },
          stacks: {
            where: { template: { source: 'system' }, status: { not: 'undeployed' } },
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

    describe('egressNetwork', () => {
      const baseEnv = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        egressGatewayIp: '172.24.0.3',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      it('reports status "missing" when no egress resource exists', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue({ ...baseEnv, egressGatewayIp: null } as any);
        mockPrisma.infraResource.findFirst.mockResolvedValue(null);

        const result = await environmentManager.getEnvironmentById('env-1');

        expect(result!.egressNetwork).toEqual({
          name: 'test-env-egress',
          subnet: null,
          bridgeGateway: null,
          gatewayContainerIp: null,
          status: 'missing',
        });
      });

      it('reports status "present" with the recorded subnet when the Docker network is live', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue(baseEnv as any);
        mockPrisma.infraResource.findFirst.mockResolvedValue({
          metadata: { subnet: '172.24.0.0/16', gateway: '172.24.0.1' },
        } as any);
        const spy = vi.spyOn(DockerService, 'getInstance').mockReturnValue({
          isConnected: () => true,
          listNetworks: vi.fn().mockResolvedValue([{ name: 'test-env-egress' }]),
        } as any);

        const result = await environmentManager.getEnvironmentById('env-1');

        expect(result!.egressNetwork).toEqual({
          name: 'test-env-egress',
          subnet: '172.24.0.0/16',
          bridgeGateway: '172.24.0.1',
          gatewayContainerIp: '172.24.0.3',
          status: 'present',
        });
        spy.mockRestore();
      });

      it('reports status "error" when a subnet is recorded but the Docker network is gone', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue(baseEnv as any);
        mockPrisma.infraResource.findFirst.mockResolvedValue({
          metadata: { subnet: '172.24.0.0/16', gateway: '172.24.0.1' },
        } as any);
        const spy = vi.spyOn(DockerService, 'getInstance').mockReturnValue({
          isConnected: () => true,
          listNetworks: vi.fn().mockResolvedValue([{ name: 'some-other-network' }]),
        } as any);

        const result = await environmentManager.getEnvironmentById('env-1');

        expect(result!.egressNetwork!.status).toBe('error');
        expect(result!.egressNetwork!.subnet).toBe('172.24.0.0/16');
        spy.mockRestore();
      });

      it('trusts the DB record (status "present") when Docker is unreachable', async () => {
        mockPrisma.environment.findUnique.mockResolvedValue(baseEnv as any);
        mockPrisma.infraResource.findFirst.mockResolvedValue({
          metadata: { subnet: '172.24.0.0/16', gateway: '172.24.0.1' },
        } as any);
        const spy = vi.spyOn(DockerService, 'getInstance').mockReturnValue({
          isConnected: () => false,
          listNetworks: vi.fn(),
        } as any);

        const result = await environmentManager.getEnvironmentById('env-1');

        expect(result!.egressNetwork!.status).toBe('present');
        spy.mockRestore();
      });
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
          _count: {
            select: {
              stacks: { where: { template: { source: 'user' } } },
            },
          },
          stacks: {
            where: { template: { source: 'system' }, status: { not: 'undeployed' } },
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
    it('should throw a NotFoundError (ENVIRONMENT_NOT_FOUND) when the id does not exist (Prisma P2025)', async () => {
      // Prisma's update() throws P2025 rather than returning null when the
      // `where` doesn't match a row — this method's `| null` return type
      // suggested a null-return path existed, but it was actually
      // unreachable. Pin the real behaviour: the service now attributes the
      // P2025 to a typed 404 instead of letting a raw Prisma error surface
      // as a generic 500.
      mockPrisma.environment.findUnique.mockResolvedValue(null);
      mockPrisma.environment.update.mockRejectedValue(
        prismaKnownRequestError('P2025', 'An operation failed because it depends on one or more records that were required but not found.'),
      );

      let caught: unknown;
      try {
        await environmentManager.updateEnvironment('missing-env', { description: 'x' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(NotFoundError);
      expect(caught).toMatchObject({
        statusCode: 404,
        code: 'ENVIRONMENT_NOT_FOUND',
        resource: { type: 'environment', id: 'missing-env' },
      });
    });

    it('should rethrow non-P2025 Prisma errors from update() unchanged', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue({ egressFirewallEnabled: false, name: 'env-1' } as any);
      const dbError = prismaKnownRequestError('P2003', 'Foreign key constraint failed');
      mockPrisma.environment.update.mockRejectedValue(dbError);

      await expect(
        environmentManager.updateEnvironment('env-1', { description: 'x' }),
      ).rejects.toBe(dbError);
    });

    it('should update environment successfully', async () => {
      const mockUpdatedEnvironment = {
        id: 'env-1',
        name: 'updated-env',
        description: 'Updated description',
        type: 'production',
        networkType: 'local',
        egressFirewallEnabled: false,
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
          _count: {
            select: {
              stacks: { where: { template: { source: 'user' } } },
            },
          },
          stacks: {
            where: { template: { source: 'system' }, status: { not: 'undeployed' } },
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
    const mockEnvironment = {
      id: 'env-1',
      name: 'test-env',
      type: 'nonproduction',
      networkType: 'local',
    };

    it('should delete environment successfully when found', async () => {
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

    it("should only query docker-network-typed InfraResource rows as network-removal candidates (fixes PR #479 review M4 — InfraResource.type is 'extensible' per its schema doc)", async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([]);

      await environmentManager.deleteEnvironment('env-1', { deleteNetworks: true });

      expect(mockPrisma.infraResource.findMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-1', type: 'docker-network' },
        select: { id: true, name: true },
      });
    });

    it('should not touch Docker or InfraResource rows when the environment owns no InfraResource records', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([]);
      const listNetworksSpy = mockDockerExecutor.getDockerClient().listNetworks as ReturnType<typeof vi.fn>;

      const result = await environmentManager.deleteEnvironment('env-1', { deleteNetworks: true });

      expect(result).toBe(true);
      expect(listNetworksSpy).not.toHaveBeenCalled();
      expect(mockPrisma.infraResource.deleteMany).not.toHaveBeenCalled();
    });

    it('should explicitly delete owned InfraResource rows even when deleteNetworks is false (fixes L4)', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([
        { id: 'ir-1', name: 'test-env-egress' },
        { id: 'ir-2', name: 'test-env-applications' },
      ] as any);
      const listNetworksSpy = mockDockerExecutor.getDockerClient().listNetworks as ReturnType<typeof vi.fn>;

      const result = await environmentManager.deleteEnvironment('env-1');

      expect(result).toBe(true);
      // deleteNetworks defaulted to false — Docker is never touched...
      expect(listNetworksSpy).not.toHaveBeenCalled();
      // ...but the dangling InfraResource rows are still cleaned up explicitly.
      expect(mockPrisma.infraResource.deleteMany).toHaveBeenCalledWith({ where: { environmentId: 'env-1' } });
    });

    it('should remove every Docker network the environment owns via NetworkManager.removeByOwner when deleteNetworks=true (fixes L3)', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([
        { id: 'ir-1', name: 'test-env-egress' },
        { id: 'ir-2', name: 'test-env-applications' },
      ] as any);
      const listNetworksSpy = mockDockerExecutor.getDockerClient().listNetworks as ReturnType<typeof vi.fn>;

      const result = await environmentManager.deleteEnvironment('env-1', { deleteNetworks: true });

      expect(result).toBe(true);
      // Label-driven lookup (not name reconstruction) — the fix for L3.
      expect(listNetworksSpy).toHaveBeenCalledWith({
        filters: {
          label: [
            'mini-infra.managed=true',
            'mini-infra.owner-kind=environment',
            'mini-infra.owner-id=env-1',
          ],
        },
      });
      // The recorded InfraResource names are passed as the pre-label-era fallback.
      expect(mockPrisma.infraResource.deleteMany).toHaveBeenCalledWith({ where: { environmentId: 'env-1' } });
    });

    it('should force-disconnect the mini-infra server / lingering containers off env networks so the network is actually removable (fixes L3)', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([
        { id: 'ir-1', name: 'test-env-egress' },
      ] as any);
      // The env's egress network still has the mini-infra server attached
      // (the container-map-pusher self-join) at delete time — the exact case
      // that used to leave every env network behind.
      mockNetworkInspect.mockResolvedValue({
        IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] },
        Containers: { 'mini-infra-server': {} },
      });
      const handle = mockDockerExecutor.getDockerClient().getNetwork();
      const disconnectSpy = handle.disconnect as ReturnType<typeof vi.fn>;
      const removeSpy = handle.remove as ReturnType<typeof vi.fn>;

      const result = await environmentManager.deleteEnvironment('env-1', { deleteNetworks: true });

      expect(result).toBe(true);
      // Force-disconnect (Force: true) then remove — not a refuse-and-leak.
      expect(disconnectSpy).toHaveBeenCalledWith({ Container: 'mini-infra-server', Force: true });
      expect(removeSpy).toHaveBeenCalled();
    });

    it("should delete the environment's own ManagedNetwork rows (scope: environment) even when deleteNetworks is false and it owns no InfraResource rows (fixes PR #479 review HIGH — orphaned rows get silently reused by name on recreate)", async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([]);

      const result = await environmentManager.deleteEnvironment('env-1');

      expect(result).toBe(true);
      expect(mockPrisma.managedNetwork.deleteMany).toHaveBeenCalledWith({
        where: { scope: 'environment', environmentId: 'env-1' },
      });
    });

    it('should delete the ManagedNetwork rows before the environment row, so a same-name stack/network created afterwards never resolves the dead row by name', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([]);

      const callOrder: string[] = [];
      (mockPrisma.managedNetwork.deleteMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('managedNetwork.deleteMany');
        return { count: 1 };
      });
      (mockPrisma.environment.delete as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('environment.delete');
        return mockEnvironment;
      });

      await environmentManager.deleteEnvironment('env-1');

      expect(callOrder).toEqual(['managedNetwork.deleteMany', 'environment.delete']);
    });

    it('should continue deleting the environment even when a network removal genuinely fails', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);
      mockPrisma.infraResource.findMany.mockResolvedValue([
        { id: 'ir-1', name: 'test-env-egress' },
      ] as any);
      // Network is empty (nothing to force-disconnect) but the remove call
      // itself fails with a non-404 (e.g. Docker hiccup) — NetworkManager.remove
      // swallows it and returns { removed:false }, so the loop must continue
      // and the environment row still gets deleted.
      mockNetworkInspect.mockResolvedValue({
        IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] },
        Containers: {},
      });
      const handle = mockDockerExecutor.getDockerClient().getNetwork();
      (handle.remove as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('docker daemon busy'), { statusCode: 500 }),
      );

      const result = await environmentManager.deleteEnvironment('env-1', { deleteNetworks: true });

      expect(result).toBe(true);
      expect(mockPrisma.environment.delete).toHaveBeenCalledWith({ where: { id: 'env-1' } });
      // The InfraResource rows are still cleaned up even though Docker removal failed.
      expect(mockPrisma.infraResource.deleteMany).toHaveBeenCalledWith({ where: { environmentId: 'env-1' } });
    });
  });
});
