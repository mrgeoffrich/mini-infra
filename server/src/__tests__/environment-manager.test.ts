import { PrismaClient } from '@prisma/client';
import { EnvironmentManager } from '../services/environment-manager';
import { ServiceRegistry } from '../services/service-registry';
import { ApplicationServiceFactory } from '../services/application-service-factory';
import { DockerExecutorService } from '../services/docker-executor';
import { ServiceStatusValues, ApplicationServiceHealthStatusValues } from '@mini-infra/types';

// Mock dependencies
jest.mock('../services/service-registry');
jest.mock('../services/application-service-factory');
jest.mock('../services/docker-executor');

const MockServiceRegistry = ServiceRegistry as jest.MockedClass<typeof ServiceRegistry>;
const MockApplicationServiceFactory = ApplicationServiceFactory as jest.MockedClass<typeof ApplicationServiceFactory>;
const MockDockerExecutorService = DockerExecutorService as jest.MockedClass<typeof DockerExecutorService>;

describe('EnvironmentManager', () => {
  let environmentManager: EnvironmentManager;
  let mockPrisma: jest.Mocked<PrismaClient>;
  let mockServiceRegistry: jest.Mocked<ServiceRegistry>;
  let mockServiceFactory: jest.Mocked<ApplicationServiceFactory>;
  let mockDockerExecutor: jest.Mocked<DockerExecutorService>;

  beforeEach(() => {
    // Reset singletons
    (EnvironmentManager as any).instance = undefined;

    // Create mock Prisma client
    mockPrisma = {
      environment: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      environmentService: {
        create: jest.fn(),
        update: jest.fn(),
      },
      environmentNetwork: {
        upsert: jest.fn(),
      },
      environmentVolume: {
        upsert: jest.fn(),
      },
    } as any;

    // Create mock instances
    mockServiceRegistry = {
      isServiceTypeAvailable: jest.fn().mockReturnValue(true),
      getServiceMetadata: jest.fn().mockReturnValue({
        name: 'haproxy',
        version: '3.2.0',
        description: 'HAProxy service',
        dependencies: ['docker'],
        tags: ['proxy'],
        requiredNetworks: [{ name: 'haproxy_network', driver: 'bridge' }],
        requiredVolumes: [{ name: 'haproxy_data' }],
        exposedPorts: []
      }),
      resolveDependencyOrder: jest.fn().mockImplementation((services) => services),
    } as any;

    mockServiceFactory = {
      createService: jest.fn().mockResolvedValue({
        success: true,
        service: {
          initialize: jest.fn().mockResolvedValue(undefined),
          start: jest.fn().mockResolvedValue({ success: true, duration: 1000 }),
          stopAndCleanup: jest.fn().mockResolvedValue(undefined),
          getStatus: jest.fn().mockResolvedValue({
            status: ServiceStatusValues.RUNNING,
            health: { status: ApplicationServiceHealthStatusValues.HEALTHY, details: {} }
          })
        }
      }),
      getService: jest.fn(),
      stopService: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockDockerExecutor = {
      initialize: jest.fn().mockResolvedValue(undefined),
      networkExists: jest.fn().mockResolvedValue(false),
      volumeExists: jest.fn().mockResolvedValue(false),
      createNetwork: jest.fn().mockResolvedValue(undefined),
      createVolume: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock singleton instances
    MockServiceRegistry.getInstance.mockReturnValue(mockServiceRegistry);
    MockApplicationServiceFactory.getInstance.mockReturnValue(mockServiceFactory);
    MockDockerExecutorService.mockImplementation(() => mockDockerExecutor);

    environmentManager = EnvironmentManager.getInstance(mockPrisma);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
        data: request,
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
      expect(mockServiceFactory.stopService).toHaveBeenCalledWith('my-haproxy');
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