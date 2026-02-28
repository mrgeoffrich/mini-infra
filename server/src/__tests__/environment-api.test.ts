import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { ServiceStatusValues, ApplicationServiceHealthStatusValues } from '@mini-infra/types';

const { mockEnvironmentManager, mockServiceRegistry } = vi.hoisted(() => ({
  mockEnvironmentManager: {
    listEnvironments: vi.fn(),
    createEnvironment: vi.fn(),
    getEnvironmentById: vi.fn(),
    updateEnvironment: vi.fn(),
    deleteEnvironment: vi.fn(),
    getEnvironmentStatus: vi.fn(),
    startEnvironment: vi.fn(),
    stopEnvironment: vi.fn(),
    addServiceToEnvironment: vi.fn(),
    getInstance: vi.fn(),
  },
  mockServiceRegistry: {
    isServiceTypeAvailable: vi.fn(),
    getAllServiceMetadata: vi.fn(),
    getServiceDefinition: vi.fn(),
    getAvailableServiceTypes: vi.fn(),
    getInstance: vi.fn(),
  },
}));

// Mock logger factory first (before other imports)
vi.mock('../lib/logger-factory', () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function() { return mockLoggerInstance; }), // Required for pino-http
    level: 'info',
    levels: {
      values: {
        fatal: 60,
        error: 50,
        warn: 40,
        info: 30,
        debug: 20,
        trace: 10,
      },
    },
    silent: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };

  return {
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    deploymentLogger: vi.fn(function() { return mockLoggerInstance; }),
    loadbalancerLogger: vi.fn(function() { return mockLoggerInstance; }),
    tlsLogger: vi.fn(function() { return mockLoggerInstance; }),
    agentLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Mock dependencies with implementations
vi.mock('../services/environment/environment-manager', () => ({
  EnvironmentManager: {
    getInstance: () => mockEnvironmentManager,
  },
}));
vi.mock('../services/environment/service-registry', () => ({
  ServiceRegistry: {
    getInstance: () => mockServiceRegistry,
  },
}));
vi.mock('../lib/prisma', () => ({
  default: {
    deploymentConfiguration: {
      findMany: vi.fn()
    }
  },
}));
vi.mock('../middleware/auth', () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    req.user = { id: 'test-user', email: 'test@example.com' };
    next();
  },
  requirePermission: () => (req: any, res: any, next: any) => {
    req.user = { id: 'test-user', email: 'test@example.com' };
    next();
  },
  getAuthenticatedUser: (req: any) => ({ id: 'test-user', email: 'test@example.com' }),
  getCurrentUserId: (req: any) => 'test-user',
  AuthErrorType: {},
  createAuthErrorResponse: vi.fn()
}));

import app from '../app';
import prisma from '../lib/prisma';

describe('Environment API', () => {
  const mockEnvironment = {
    id: 'env-1',
    name: 'test-environment',
    description: 'Test environment',
    type: 'nonproduction',
    networkType: 'local',
    status: ServiceStatusValues.RUNNING,
    isActive: true,
    services: [{
      id: 'service-1',
      environmentId: 'env-1',
      serviceName: 'my-haproxy',
      serviceType: 'haproxy',
      status: ServiceStatusValues.RUNNING,
      health: ApplicationServiceHealthStatusValues.HEALTHY,
      config: {},
      createdAt: new Date('2025-09-17T10:31:21.990Z'),
      updatedAt: new Date('2025-09-17T10:31:21.990Z')
    }],
    networks: [{
      id: 'network-1',
      environmentId: 'env-1',
      name: 'haproxy_network',
      driver: 'bridge',
      createdAt: new Date('2025-09-17T10:31:21.990Z')
    }],
    volumes: [{
      id: 'volume-1',
      environmentId: 'env-1',
      name: 'haproxy_data',
      driver: 'local',
      createdAt: new Date('2025-09-17T10:31:21.990Z')
    }],
    createdAt: new Date(),
    updatedAt: new Date()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Prisma mock
    (prisma.deploymentConfiguration.findMany as Mock).mockReset();
  });

  describe('GET /api/environments', () => {
    it('should list environments successfully', async () => {
      mockEnvironmentManager.listEnvironments.mockResolvedValue({
        environments: [mockEnvironment],
        total: 1
      });

      const response = await request(app)
        .get('/api/environments')
        .expect(200);

      expect(response.body).toEqual({
        environments: [expect.objectContaining({
          id: 'env-1',
          name: 'test-environment'
        })],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      });

      expect(mockEnvironmentManager.listEnvironments).toHaveBeenCalledWith(
        undefined, undefined, 1, 20
      );
    });

    it('should filter environments by type and status', async () => {
      mockEnvironmentManager.listEnvironments.mockResolvedValue({
        environments: [],
        total: 0
      });

      await request(app)
        .get('/api/environments?type=production&status=running&page=2&limit=10')
        .expect(200);

      expect(mockEnvironmentManager.listEnvironments).toHaveBeenCalledWith(
        'production', 'running', 2, 10
      );
    });

    it('should handle service errors', async () => {
      mockEnvironmentManager.listEnvironments.mockRejectedValue(new Error('Database error'));

      await request(app)
        .get('/api/environments')
        .expect(500);
    });
  });

  describe('POST /api/environments', () => {
    it('should create environment successfully', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(true);
      mockEnvironmentManager.createEnvironment.mockResolvedValue(mockEnvironment);

      const createRequest = {
        name: 'new-environment',
        description: 'New test environment',
        type: 'nonproduction',
        networkType: 'internet',
        services: [{
          serviceName: 'my-haproxy',
          serviceType: 'haproxy',
          config: { setting: 'value' }
        }]
      };

      const response = await request(app)
        .post('/api/environments')
        .send(createRequest)
        .expect(201);

      expect(response.body).toEqual(expect.objectContaining({
        id: 'env-1',
        name: 'test-environment'
      }));

      expect(mockEnvironmentManager.createEnvironment).toHaveBeenCalledWith(createRequest, 'test-user');
      expect(mockServiceRegistry.isServiceTypeAvailable).toHaveBeenCalledWith('haproxy');
    });

    it('should reject invalid service type', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(false);
      mockServiceRegistry.getAvailableServiceTypes.mockReturnValue(['haproxy']);

      const createRequest = {
        name: 'new-environment',
        type: 'nonproduction',
        services: [{
          serviceName: 'unknown-service',
          serviceType: 'unknown'
        }]
      };

      const response = await request(app)
        .post('/api/environments')
        .send(createRequest)
        .expect(400);

      expect(response.body.error).toBe('Invalid service type');
      expect(response.body.availableTypes).toEqual(['haproxy']);
    });

    it('should handle duplicate environment name', async () => {
      const duplicateError = new Error('Unique constraint failed');
      duplicateError.message = 'Unique constraint failed on the constraint: `environments_name_key`';

      mockEnvironmentManager.createEnvironment.mockRejectedValue(duplicateError);

      const createRequest = {
        name: 'existing-environment',
        type: 'nonproduction'
      };

      const response = await request(app)
        .post('/api/environments')
        .send(createRequest)
        .expect(409);

      expect(response.body.error).toBe('Environment name already exists');
    });

    it('should create environment with default local network type', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(true);
      mockEnvironmentManager.createEnvironment.mockResolvedValue(mockEnvironment);

      const createRequest = {
        name: 'new-environment',
        description: 'New test environment',
        type: 'nonproduction'
        // networkType is omitted - should default to 'local'
      };

      const response = await request(app)
        .post('/api/environments')
        .send(createRequest)
        .expect(201);

      expect(response.body).toEqual(expect.objectContaining({
        id: 'env-1',
        name: 'test-environment'
      }));

      expect(mockEnvironmentManager.createEnvironment).toHaveBeenCalledWith(createRequest, 'test-user');
    });

    it('should pass through networkType to createEnvironment', async () => {
      mockEnvironmentManager.createEnvironment.mockResolvedValue(mockEnvironment);

      const createRequest = {
        name: 'new-environment',
        type: 'nonproduction',
        networkType: 'local'
      };

      await request(app)
        .post('/api/environments')
        .send(createRequest)
        .expect(201);

      expect(mockEnvironmentManager.createEnvironment).toHaveBeenCalledWith(createRequest, 'test-user');
    });

    it('should accept valid networkType values', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(true);
      mockEnvironmentManager.createEnvironment.mockResolvedValue({...mockEnvironment, networkType: 'internet'});

      const createRequest = {
        name: 'internet-environment',
        type: 'nonproduction',
        networkType: 'internet'
      };

      const response = await request(app)
        .post('/api/environments')
        .send(createRequest)
        .expect(201);

      expect(mockEnvironmentManager.createEnvironment).toHaveBeenCalledWith(createRequest, 'test-user');
    });
  });

  describe('GET /api/environments/:id', () => {
    it('should get environment by id successfully', async () => {
      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .get('/api/environments/env-1')
        .expect(200);

      expect(response.body).toEqual(expect.objectContaining({
        id: 'env-1',
        name: 'test-environment'
      }));

      expect(mockEnvironmentManager.getEnvironmentById).toHaveBeenCalledWith('env-1');
    });

    it('should return 404 for non-existent environment', async () => {
      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/environments/non-existent')
        .expect(404);

      expect(response.body.error).toBe('Environment not found');
    });
  });

  describe('PUT /api/environments/:id', () => {
    it('should update environment successfully', async () => {
      const updatedEnvironment = { ...mockEnvironment, name: 'updated-environment' };
      mockEnvironmentManager.updateEnvironment.mockResolvedValue(updatedEnvironment);

      const updateRequest = {
        description: 'Updated description',
        networkType: 'internet'
      };

      const response = await request(app)
        .put('/api/environments/env-1')
        .send(updateRequest)
        .expect(200);

      expect(response.body.name).toBe('updated-environment');
      expect(mockEnvironmentManager.updateEnvironment).toHaveBeenCalledWith('env-1', updateRequest);
    });

    it('should update environment networkType successfully', async () => {
      const updatedEnvironment = { ...mockEnvironment, networkType: 'internet' };
      mockEnvironmentManager.updateEnvironment.mockResolvedValue(updatedEnvironment);

      const updateRequest = {
        networkType: 'internet'
      };

      const response = await request(app)
        .put('/api/environments/env-1')
        .send(updateRequest)
        .expect(200);

      expect(response.body.networkType).toBe('internet');
      expect(mockEnvironmentManager.updateEnvironment).toHaveBeenCalledWith('env-1', updateRequest);
    });

    it('should pass through networkType in update request', async () => {
      const updatedEnvironment = { ...mockEnvironment, networkType: 'local' };
      mockEnvironmentManager.updateEnvironment.mockResolvedValue(updatedEnvironment);

      const updateRequest = {
        networkType: 'local'
      };

      const response = await request(app)
        .put('/api/environments/env-1')
        .send(updateRequest)
        .expect(200);

      expect(mockEnvironmentManager.updateEnvironment).toHaveBeenCalledWith('env-1', updateRequest);
    });

    it('should return 404 for non-existent environment', async () => {
      mockEnvironmentManager.updateEnvironment.mockResolvedValue(null);

      await request(app)
        .put('/api/environments/non-existent')
        .send({ description: 'updated-description' })
        .expect(404);
    });
  });

  describe('DELETE /api/environments/:id', () => {
    it('should delete environment successfully', async () => {
      // Mock no deployment configurations to allow deletion
      (prisma.deploymentConfiguration.findMany as Mock).mockResolvedValue([]);
      mockEnvironmentManager.deleteEnvironment.mockResolvedValue(true);

      await request(app)
        .delete('/api/environments/env-1')
        .expect(204);

      expect(mockEnvironmentManager.deleteEnvironment).toHaveBeenCalledWith('env-1', {
        deleteVolumes: false,
        deleteNetworks: false,
        userId: 'test-user'
      });
    });

    it('should return 404 for non-existent environment', async () => {
      // Mock no deployment configurations
      (prisma.deploymentConfiguration.findMany as Mock).mockResolvedValue([]);
      mockEnvironmentManager.deleteEnvironment.mockResolvedValue(false);

      await request(app)
        .delete('/api/environments/non-existent')
        .expect(404);
    });

    it('should handle running environment deletion error', async () => {
      // Mock no deployment configurations to pass the first check
      (prisma.deploymentConfiguration.findMany as Mock).mockResolvedValue([]);
      const runningError = new Error('Cannot delete a running environment. Stop it first.');
      mockEnvironmentManager.deleteEnvironment.mockRejectedValue(runningError);

      const response = await request(app)
        .delete('/api/environments/env-1')
        .expect(400);

      expect(response.body.error).toBe('Environment is running');
    });

    it('should prevent deletion when environment has deployment configurations', async () => {
      // Mock deploymentConfigurations that exist for this environment
      const mockDeploymentConfigs = [
        { id: 'deploy-1', applicationName: 'my-app' },
        { id: 'deploy-2', applicationName: 'other-app' }
      ];

      (prisma.deploymentConfiguration.findMany as Mock).mockResolvedValue(mockDeploymentConfigs);

      const response = await request(app)
        .delete('/api/environments/env-with-deployments')
        .expect(400);

      expect(response.body.error).toBe('Environment has associated deployments');
      expect(response.body.message).toContain('my-app, other-app');
      expect(response.body.deploymentConfigurations).toEqual(mockDeploymentConfigs);

      // Verify that the Prisma query was called with the correct environment ID
      expect(prisma.deploymentConfiguration.findMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-with-deployments' },
        select: { id: true, applicationName: true }
      });
    });

    it('should allow deletion when environment has no deployment configurations', async () => {
      // Mock no deployment configurations
      (prisma.deploymentConfiguration.findMany as Mock).mockResolvedValue([]);
      mockEnvironmentManager.deleteEnvironment.mockResolvedValue(true);

      await request(app)
        .delete('/api/environments/env-no-deployments')
        .expect(204);

      // Verify that the deployment check was performed
      expect(prisma.deploymentConfiguration.findMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-no-deployments' },
        select: { id: true, applicationName: true }
      });

      // Verify that deletion proceeded normally
      expect(mockEnvironmentManager.deleteEnvironment).toHaveBeenCalledWith('env-no-deployments', {
        deleteVolumes: false,
        deleteNetworks: false,
        userId: 'test-user'
      });
    });
  });

  describe('GET /api/environments/:id/status', () => {
    it('should get environment status successfully', async () => {
      const statusResponse = {
        environment: mockEnvironment,
        servicesHealth: [{
          serviceName: 'my-haproxy',
          status: ServiceStatusValues.RUNNING,
          health: ApplicationServiceHealthStatusValues.HEALTHY,
          healthDetails: { uptime: 1000 }
        }],
        networksStatus: [{
          name: 'haproxy_network',
          exists: true,
          dockerId: 'network-123'
        }],
        volumesStatus: [{
          name: 'haproxy_data',
          exists: true,
          dockerId: 'volume-123'
        }]
      };

      mockEnvironmentManager.getEnvironmentStatus.mockResolvedValue(statusResponse);

      const response = await request(app)
        .get('/api/environments/env-1/status')
        .expect(200);

      expect(response.body).toEqual({
        ...statusResponse,
        environment: {
          ...statusResponse.environment,
          createdAt: statusResponse.environment.createdAt.toISOString(),
          updatedAt: statusResponse.environment.updatedAt.toISOString(),
          services: statusResponse.environment.services.map(service => ({
            ...service,
            createdAt: service.createdAt.toISOString(),
            updatedAt: service.updatedAt.toISOString()
          })),
          networks: statusResponse.environment.networks.map(network => ({
            ...network,
            createdAt: network.createdAt.toISOString()
          })),
          volumes: statusResponse.environment.volumes.map(volume => ({
            ...volume,
            createdAt: volume.createdAt.toISOString()
          }))
        }
      });
      expect(mockEnvironmentManager.getEnvironmentStatus).toHaveBeenCalledWith('env-1');
    });

    it('should return 404 for non-existent environment', async () => {
      mockEnvironmentManager.getEnvironmentStatus.mockResolvedValue(null);

      await request(app)
        .get('/api/environments/non-existent/status')
        .expect(404);
    });
  });

  describe('POST /api/environments/:id/start', () => {
    it('should start environment successfully', async () => {
      const startResult = {
        success: true,
        message: 'Environment started successfully',
        duration: 5000
      };

      mockEnvironmentManager.startEnvironment.mockResolvedValue(startResult);

      const response = await request(app)
        .post('/api/environments/env-1/start')
        .expect(200);

      expect(response.body).toEqual(startResult);
      expect(mockEnvironmentManager.startEnvironment).toHaveBeenCalledWith('env-1', 'test-user');
    });

    it('should handle start failure', async () => {
      const startResult = {
        success: false,
        message: 'Failed to start service',
        details: { error: 'Docker connection failed' }
      };

      mockEnvironmentManager.startEnvironment.mockResolvedValue(startResult);

      const response = await request(app)
        .post('/api/environments/env-1/start')
        .expect(400);

      expect(response.body.error).toBe('Failed to start environment');
      expect(response.body.message).toBe('Failed to start service');
    });
  });

  describe('POST /api/environments/:id/stop', () => {
    it('should stop environment successfully', async () => {
      const stopResult = {
        success: true,
        message: 'Environment stopped successfully',
        duration: 3000
      };

      mockEnvironmentManager.stopEnvironment.mockResolvedValue(stopResult);

      const response = await request(app)
        .post('/api/environments/env-1/stop')
        .expect(200);

      expect(response.body).toEqual(stopResult);
      expect(mockEnvironmentManager.stopEnvironment).toHaveBeenCalledWith('env-1', 'test-user');
    });
  });

  describe('GET /api/environments/:id/services', () => {
    it('should list environment services', async () => {
      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .get('/api/environments/env-1/services')
        .expect(200);

      expect(response.body).toEqual(mockEnvironment.services.map(service => ({
        ...service,
        createdAt: service.createdAt.toISOString(),
        updatedAt: service.updatedAt.toISOString()
      })));
      expect(mockEnvironmentManager.getEnvironmentById).toHaveBeenCalledWith('env-1');
    });

    it('should return 404 for non-existent environment', async () => {
      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(null);

      await request(app)
        .get('/api/environments/non-existent/services')
        .expect(404);
    });
  });

  describe('POST /api/environments/:id/services', () => {
    it('should add service to environment successfully', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(true);
      mockEnvironmentManager.addServiceToEnvironment.mockResolvedValue(undefined);
      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const addServiceRequest = {
        serviceName: 'new-service',
        serviceType: 'haproxy',
        config: { setting: 'value' }
      };

      const response = await request(app)
        .post('/api/environments/env-1/services')
        .send(addServiceRequest)
        .expect(201);

      expect(response.body).toEqual(expect.objectContaining({
        id: 'env-1',
        name: 'test-environment'
      }));

      expect(mockEnvironmentManager.addServiceToEnvironment).toHaveBeenCalledWith('env-1', addServiceRequest);
      expect(mockServiceRegistry.isServiceTypeAvailable).toHaveBeenCalledWith('haproxy');
    });

    it('should reject invalid service type', async () => {
      mockServiceRegistry.isServiceTypeAvailable.mockReturnValue(false);
      mockServiceRegistry.getAvailableServiceTypes.mockReturnValue(['haproxy']);

      const addServiceRequest = {
        serviceName: 'unknown-service',
        serviceType: 'unknown'
      };

      const response = await request(app)
        .post('/api/environments/env-1/services')
        .send(addServiceRequest)
        .expect(400);

      expect(response.body.error).toBe('Invalid service type');
      expect(response.body.availableTypes).toEqual(['haproxy']);
    });
  });

  describe('GET /api/environments/services/available', () => {
    it('should list available service types', async () => {
      const availableServices = [{
        serviceType: 'haproxy',
        description: 'HAProxy load balancer',
        name: 'haproxy',
        version: '3.2.0',
        dependencies: ['docker'],
        tags: ['proxy'],
        requiredNetworks: [],
        requiredVolumes: [],
        exposedPorts: []
      }];

      mockServiceRegistry.getAllServiceMetadata.mockReturnValue(availableServices);

      const response = await request(app)
        .get('/api/environments/services/available')
        .expect(200);

      expect(response.body.services).toEqual(availableServices);
      expect(mockServiceRegistry.getAllServiceMetadata).toHaveBeenCalled();
    });
  });

  describe('GET /api/environments/services/available/:serviceType', () => {
    it('should get service type metadata', async () => {
      const serviceDefinition = {
        serviceType: 'haproxy',
        description: 'HAProxy load balancer',
        metadata: {
          version: '3.2.0',
          dependencies: ['docker'],
          tags: ['proxy'],
          requiredNetworks: [],
          requiredVolumes: [],
          exposedPorts: []
        }
      };

      const expectedResponse = {
        serviceType: 'haproxy',
        description: 'HAProxy load balancer',
        version: '3.2.0',
        dependencies: ['docker'],
        tags: ['proxy'],
        requiredNetworks: [],
        requiredVolumes: [],
        exposedPorts: []
      };

      mockServiceRegistry.getServiceDefinition.mockReturnValue(serviceDefinition);

      const response = await request(app)
        .get('/api/environments/services/available/haproxy')
        .expect(200);

      expect(response.body).toEqual(expectedResponse);
      expect(mockServiceRegistry.getServiceDefinition).toHaveBeenCalledWith('haproxy');
    });

    it('should return 404 for unknown service type', async () => {
      mockServiceRegistry.getServiceDefinition.mockReturnValue(undefined);
      mockServiceRegistry.getAvailableServiceTypes.mockReturnValue(['haproxy']);

      const response = await request(app)
        .get('/api/environments/services/available/unknown')
        .expect(404);

      expect(response.body.error).toBe('Service type not found');
      expect(response.body.availableTypes).toEqual(['haproxy']);
    });
  });
});