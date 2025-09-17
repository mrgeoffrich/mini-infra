import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { ServiceStatus, ApplicationServiceHealthStatus } from '@mini-infra/types';

// Mock logger factory first (before other imports)
jest.mock('../lib/logger-factory', () => {
  const mockLoggerInstance = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mockLoggerInstance), // Required for pino-http
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
    silent: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
  };

  return {
    appLogger: jest.fn(() => mockLoggerInstance),
    servicesLogger: jest.fn(() => mockLoggerInstance),
    httpLogger: jest.fn(() => mockLoggerInstance),
    prismaLogger: jest.fn(() => mockLoggerInstance),
    __esModule: true,
    default: jest.fn(() => mockLoggerInstance),
  };
});

// Mock dependencies
jest.mock('../services/environment-manager');
jest.mock('../services/service-registry');
jest.mock('../lib/auth-middleware', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: 'test-user', email: 'test@example.com' };
    next();
  },
  AuthErrorType: {},
  createAuthErrorResponse: jest.fn()
}));

const mockEnvironmentManager = {
  listEnvironments: jest.fn(),
  createEnvironment: jest.fn(),
  getEnvironmentById: jest.fn(),
  updateEnvironment: jest.fn(),
  deleteEnvironment: jest.fn(),
  getEnvironmentStatus: jest.fn(),
  startEnvironment: jest.fn(),
  stopEnvironment: jest.fn(),
  addServiceToEnvironment: jest.fn(),
  getInstance: jest.fn()
};

const mockServiceRegistry = {
  isServiceTypeAvailable: jest.fn(),
  getAllServiceMetadata: jest.fn(),
  getServiceDefinition: jest.fn(),
  getAvailableServiceTypes: jest.fn(),
  getInstance: jest.fn()
};

// Mock the modules
jest.doMock('../services/environment-manager', () => ({
  EnvironmentManager: {
    getInstance: () => mockEnvironmentManager
  }
}));

jest.doMock('../services/service-registry', () => ({
  ServiceRegistry: {
    getInstance: () => mockServiceRegistry
  }
}));

// Import app after mocks are set up
import app from '../app';

describe('Environment API', () => {
  const mockEnvironment = {
    id: 'env-1',
    name: 'test-environment',
    description: 'Test environment',
    type: 'nonproduction',
    status: ServiceStatus.RUNNING,
    isActive: true,
    services: [{
      id: 'service-1',
      environmentId: 'env-1',
      serviceName: 'my-haproxy',
      serviceType: 'haproxy',
      status: ServiceStatus.RUNNING,
      health: ApplicationServiceHealthStatus.HEALTHY,
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
    jest.clearAllMocks();
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
        'production', 'running', '2', '10'
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

      expect(mockEnvironmentManager.createEnvironment).toHaveBeenCalledWith(createRequest);
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
        name: 'updated-environment',
        description: 'Updated description'
      };

      const response = await request(app)
        .put('/api/environments/env-1')
        .send(updateRequest)
        .expect(200);

      expect(response.body.name).toBe('updated-environment');
      expect(mockEnvironmentManager.updateEnvironment).toHaveBeenCalledWith('env-1', updateRequest);
    });

    it('should return 404 for non-existent environment', async () => {
      mockEnvironmentManager.updateEnvironment.mockResolvedValue(null);

      await request(app)
        .put('/api/environments/non-existent')
        .send({ name: 'updated-name' })
        .expect(404);
    });
  });

  describe('DELETE /api/environments/:id', () => {
    it('should delete environment successfully', async () => {
      mockEnvironmentManager.deleteEnvironment.mockResolvedValue(true);

      await request(app)
        .delete('/api/environments/env-1')
        .expect(204);

      expect(mockEnvironmentManager.deleteEnvironment).toHaveBeenCalledWith('env-1');
    });

    it('should return 404 for non-existent environment', async () => {
      mockEnvironmentManager.deleteEnvironment.mockResolvedValue(false);

      await request(app)
        .delete('/api/environments/non-existent')
        .expect(404);
    });

    it('should handle running environment deletion error', async () => {
      const runningError = new Error('Cannot delete a running environment. Stop it first.');
      mockEnvironmentManager.deleteEnvironment.mockRejectedValue(runningError);

      const response = await request(app)
        .delete('/api/environments/env-1')
        .expect(400);

      expect(response.body.error).toBe('Environment is running');
    });
  });

  describe('GET /api/environments/:id/status', () => {
    it('should get environment status successfully', async () => {
      const statusResponse = {
        environment: mockEnvironment,
        servicesHealth: [{
          serviceName: 'my-haproxy',
          status: ServiceStatus.RUNNING,
          health: ApplicationServiceHealthStatus.HEALTHY,
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
      expect(mockEnvironmentManager.startEnvironment).toHaveBeenCalledWith('env-1');
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
      expect(mockEnvironmentManager.stopEnvironment).toHaveBeenCalledWith('env-1');
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
          name: 'haproxy',
          version: '3.2.0',
          dependencies: ['docker'],
          tags: ['proxy'],
          requiredNetworks: [],
          requiredVolumes: [],
          exposedPorts: []
        }
      };

      mockServiceRegistry.getServiceDefinition.mockReturnValue(serviceDefinition);

      const response = await request(app)
        .get('/api/environments/services/available/haproxy')
        .expect(200);

      expect(response.body).toEqual(serviceDefinition);
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