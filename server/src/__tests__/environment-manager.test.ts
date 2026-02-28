import { PrismaClient } from '@prisma/client';
import { EnvironmentManager, ServiceRegistry } from '../services/environment';
import { ApplicationServiceFactory } from '../services/application-service-factory';
import { DockerExecutorService } from '../services/docker-executor';
import { ServiceStatusValues, ApplicationServiceHealthStatusValues } from '@mini-infra/types';

// Mock dependencies
vi.mock('../services/environment/service-registry');
vi.mock('../services/application-service-factory');
vi.mock('../services/docker-executor');
vi.mock('../services/user-events', () => {
  const MockUserEventService = class {
    createEvent = vi.fn().mockResolvedValue({ id: 'user-event-1' });
    updateEvent = vi.fn().mockResolvedValue({});
    appendLogs = vi.fn().mockResolvedValue({});
  };
  return { UserEventService: MockUserEventService };
});
vi.mock('../services/port-utils', () => ({
  portUtils: {
    validatePortsForEnvironment: vi.fn().mockResolvedValue({
      config: {},
      validation: { isValid: true, message: 'OK', unavailablePorts: [], conflicts: [] },
    }),
  },
}));

const MockServiceRegistry = ServiceRegistry as MockedClass<typeof ServiceRegistry>;
const MockApplicationServiceFactory = ApplicationServiceFactory as MockedClass<typeof ApplicationServiceFactory>;
const MockDockerExecutorService = DockerExecutorService as MockedClass<typeof DockerExecutorService>;

describe('EnvironmentManager', () => {
  let environmentManager: EnvironmentManager;
  let mockPrisma: Mocked<PrismaClient>;
  let mockServiceRegistry: Mocked<ServiceRegistry>;
  let mockServiceFactory: Mocked<ApplicationServiceFactory>;
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
      environmentService: {
        create: vi.fn(),
        update: vi.fn(),
      },
      environmentNetwork: {
        upsert: vi.fn(),
      },
      environmentVolume: {
        upsert: vi.fn(),
      },
    } as any;

    // Create mock instances
    mockServiceRegistry = {
      isServiceTypeAvailable: vi.fn().mockReturnValue(true),
      getServiceMetadata: vi.fn().mockReturnValue({
        name: 'haproxy',
        version: '3.2.0',
        description: 'HAProxy service',
        dependencies: ['docker'],
        tags: ['proxy'],
        requiredNetworks: [{ name: 'haproxy_network', driver: 'bridge' }],
        requiredVolumes: [{ name: 'haproxy_data' }],
        exposedPorts: []
      }),
      resolveDependencyOrder: vi.fn().mockImplementation((services) => services),
    } as any;

    mockServiceFactory = {
      createService: vi.fn().mockResolvedValue({
        success: true,
        service: {
          initialize: vi.fn().mockResolvedValue(undefined),
          start: vi.fn().mockResolvedValue({ success: true, duration: 1000 }),
          stopAndCleanup: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn().mockResolvedValue({
            status: ServiceStatusValues.RUNNING,
            health: { status: ApplicationServiceHealthStatusValues.HEALTHY, details: {} }
          })
        }
      }),
      getService: vi.fn(),
      stopService: vi.fn().mockResolvedValue(undefined),
    } as any;

    mockDockerExecutor = {
      initialize: vi.fn().mockResolvedValue(undefined),
      networkExists: vi.fn().mockResolvedValue(false),
      volumeExists: vi.fn().mockResolvedValue(false),
      createNetwork: vi.fn().mockResolvedValue(undefined),
      createVolume: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Mock singleton instances
    MockServiceRegistry.getInstance.mockReturnValue(mockServiceRegistry);
    MockApplicationServiceFactory.getInstance.mockReturnValue(mockServiceFactory);
    MockDockerExecutorService.mockImplementation(function() { return mockDockerExecutor; });

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
      const mockEnvironmentData = {
        id: 'env-1',
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction',
        networkType: 'local',
        status: ServiceStatusValues.UNINITIALIZED,
        isActive: false,
        services: [],
        networks: [],
        volumes: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.create.mockResolvedValue(mockEnvironmentData);
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironmentData);

      const request = {
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction' as const
      };

      const result = await environmentManager.createEnvironment(request);

      expect(result).toEqual(mockEnvironmentData);
      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: 'Test environment',
          type: 'nonproduction',
          networkType: 'local',
          status: ServiceStatusValues.UNINITIALIZED,
          isActive: false
        },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });
    });

    it('should create environment with services', async () => {
      const mockEnvironmentData = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        status: ServiceStatusValues.UNINITIALIZED,
        isActive: false,
        services: [],
        networks: [],
        volumes: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.create.mockResolvedValue(mockEnvironmentData);
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironmentData);

      const request = {
        name: 'test-env',
        type: 'nonproduction' as const,
        services: [{
          serviceName: 'my-haproxy',
          serviceType: 'haproxy',
          config: { setting: 'value' }
        }]
      };

      await environmentManager.createEnvironment(request);

      expect(mockServiceRegistry.isServiceTypeAvailable).toHaveBeenCalledWith('haproxy');
    });

    it('should fail for unknown service type', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(false);

      const request = {
        name: 'test-env',
        type: 'nonproduction' as const,
        services: [{
          serviceName: 'unknown-service',
          serviceType: 'unknown'
        }]
      };

      await expect(environmentManager.createEnvironment(request))
        .rejects.toThrow('Unknown service type: unknown');
    });

    it('should create environment with specified networkType', async () => {
      const mockEnvironmentData = {
        id: 'env-1',
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction',
        networkType: 'internet',
        status: ServiceStatusValues.UNINITIALIZED,
        isActive: false,
        services: [],
        networks: [],
        volumes: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.create.mockResolvedValue(mockEnvironmentData);
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironmentData);

      const request = {
        name: 'test-env',
        description: 'Test environment',
        type: 'nonproduction' as const,
        networkType: 'internet' as const
      };

      const result = await environmentManager.createEnvironment(request);

      expect(result).toEqual(mockEnvironmentData);
      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: 'Test environment',
          type: 'nonproduction',
          networkType: 'internet',
          status: ServiceStatusValues.UNINITIALIZED,
          isActive: false
        },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });
    });

    it('should default networkType to local if not specified', async () => {
      const mockEnvironmentData = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        networkType: 'local',
        status: ServiceStatusValues.UNINITIALIZED,
        isActive: false,
        services: [],
        networks: [],
        volumes: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.create.mockResolvedValue(mockEnvironmentData);
      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironmentData);

      const request = {
        name: 'test-env',
        type: 'nonproduction' as const
        // networkType is omitted, should default to 'local'
      };

      const result = await environmentManager.createEnvironment(request);

      expect(result).toEqual(mockEnvironmentData);
      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: {
          name: 'test-env',
          description: undefined,
          type: 'nonproduction',
          networkType: 'local',
          status: ServiceStatusValues.UNINITIALIZED,
          isActive: false
        },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });
    });
  });

  describe('getEnvironmentById', () => {
    it('should return environment when found', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        status: ServiceStatusValues.RUNNING,
        isActive: true,
        services: [],
        networks: [],
        volumes: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment);

      const result = await environmentManager.getEnvironmentById('env-1');

      expect(result).toEqual(mockEnvironment);
      expect(mockPrisma.environment.findUnique).toHaveBeenCalledWith({
        where: { id: 'env-1' },
        include: {
          services: true,
          networks: true,
          volumes: true
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
          status: ServiceStatusValues.RUNNING,
          isActive: true,
          services: [],
          networks: [],
          volumes: [],
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ];

      mockPrisma.environment.findMany.mockResolvedValue(mockEnvironments);
      mockPrisma.environment.count.mockResolvedValue(1);

      const result = await environmentManager.listEnvironments('production', ServiceStatusValues.RUNNING, 1, 10);

      expect(result.environments).toEqual(mockEnvironments);
      expect(result.total).toBe(1);
      expect(mockPrisma.environment.findMany).toHaveBeenCalledWith({
        where: { type: 'production', status: ServiceStatusValues.RUNNING },
        include: {
          services: true,
          networks: true,
          volumes: true
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
        status: ServiceStatusValues.RUNNING,
        isActive: true,
        services: [],
        networks: [],
        volumes: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockPrisma.environment.update.mockResolvedValue(mockUpdatedEnvironment);

      const request = {
        name: 'updated-env',
        description: 'Updated description',
        type: 'production' as const
      };

      const result = await environmentManager.updateEnvironment('env-1', request);

      expect(result).toEqual(mockUpdatedEnvironment);
      expect(mockPrisma.environment.update).toHaveBeenCalledWith({
        where: { id: 'env-1' },
        data: {
          description: 'Updated description',
          type: 'production',
          networkType: undefined,
          isActive: undefined
        },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });
    });
  });

  describe('deleteEnvironment', () => {
    it('should delete stopped environment successfully', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        status: ServiceStatusValues.STOPPED,
        services: [],
        networks: [],
        volumes: []
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.delete.mockResolvedValue(mockEnvironment as any);

      const result = await environmentManager.deleteEnvironment('env-1');

      expect(result).toBe(true);
      expect(mockPrisma.environment.delete).toHaveBeenCalledWith({
        where: { id: 'env-1' }
      });
    });

    it('should fail to delete running environment', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        status: ServiceStatusValues.RUNNING,
        services: [],
        networks: [],
        volumes: []
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);

      await expect(environmentManager.deleteEnvironment('env-1'))
        .rejects.toThrow('Cannot delete a running environment. Stop it first.');
    });

    it('should return false for non-existent environment', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(null);

      const result = await environmentManager.deleteEnvironment('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('startEnvironment', () => {
    it('should start environment successfully', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        status: ServiceStatusValues.INITIALIZED,
        services: [{
          id: 'service-1',
          serviceName: 'my-haproxy',
          serviceType: 'haproxy',
          config: {}
        }],
        networks: [{ name: 'haproxy_network', driver: 'bridge' }],
        volumes: [{ name: 'haproxy_data' }]
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.update.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environmentService.update.mockResolvedValue({} as any);

      const result = await environmentManager.startEnvironment('env-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Environment started successfully');
      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
      expect(mockServiceFactory.createService).toHaveBeenCalled();
    });

    it('should return success if environment already running', async () => {
      const mockEnvironment = {
        id: 'env-1',
        status: ServiceStatusValues.RUNNING,
        services: [],
        networks: [],
        volumes: []
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);

      const result = await environmentManager.startEnvironment('env-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Environment is already running');
    });

    it('should return failure for non-existent environment', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(null);

      const result = await environmentManager.startEnvironment('non-existent');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Environment not found');
    });
  });

  describe('stopEnvironment', () => {
    it('should stop environment successfully', async () => {
      const mockEnvironment = {
        id: 'env-1',
        name: 'test-env',
        status: ServiceStatusValues.RUNNING,
        services: [{
          id: 'service-1',
          serviceName: 'my-haproxy',
          serviceType: 'haproxy'
        }],
        networks: [],
        volumes: []
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environment.update.mockResolvedValue(mockEnvironment as any);
      mockPrisma.environmentService.update.mockResolvedValue({} as any);

      const result = await environmentManager.stopEnvironment('env-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Environment stopped successfully');
      expect(mockServiceFactory.stopService).toHaveBeenCalledWith('test-env-my-haproxy', 'env-1');
    });

    it('should return success if environment already stopped', async () => {
      const mockEnvironment = {
        id: 'env-1',
        status: ServiceStatusValues.STOPPED,
        services: [],
        networks: [],
        volumes: []
      };

      mockPrisma.environment.findUnique.mockResolvedValue(mockEnvironment as any);

      const result = await environmentManager.stopEnvironment('env-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Environment is already stopped');
    });
  });

  describe('addServiceToEnvironment', () => {
    it('should add service to environment successfully', async () => {
      const serviceConfig = {
        serviceName: 'my-haproxy',
        serviceType: 'haproxy',
        config: { setting: 'value' }
      };

      mockPrisma.environment.findUnique.mockResolvedValue({
        id: 'env-1',
        name: 'test-env',
        type: 'nonproduction',
        status: ServiceStatusValues.UNINITIALIZED,
        isActive: false,
        services: [],
        networks: [],
        volumes: []
      } as any);
      mockPrisma.environmentNetwork.upsert.mockResolvedValue({} as any);
      mockPrisma.environmentVolume.upsert.mockResolvedValue({} as any);
      mockPrisma.environmentService.create.mockResolvedValue({} as any);

      await environmentManager.addServiceToEnvironment('env-1', serviceConfig);

      expect(mockServiceRegistry.isServiceTypeAvailable).toHaveBeenCalledWith('haproxy');
      expect(mockServiceRegistry.getServiceMetadata).toHaveBeenCalledWith('haproxy');
      expect(mockPrisma.environmentService.create).toHaveBeenCalledWith({
        data: {
          environmentId: 'env-1',
          serviceName: 'my-haproxy',
          serviceType: 'haproxy',
          status: ServiceStatusValues.UNINITIALIZED,
          health: ApplicationServiceHealthStatusValues.UNKNOWN,
          config: { setting: 'value' }
        }
      });
    });

    it('should fail for unknown service type', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(false);

      const serviceConfig = {
        serviceName: 'unknown-service',
        serviceType: 'unknown'
      };

      await expect(environmentManager.addServiceToEnvironment('env-1', serviceConfig))
        .rejects.toThrow('Unknown service type: unknown');
    });
  });
});