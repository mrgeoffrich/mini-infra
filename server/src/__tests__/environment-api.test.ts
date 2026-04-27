import request from 'supertest';

const { mockEnvironmentManager, mockPrisma } = vi.hoisted(() => ({
  mockEnvironmentManager: {
    listEnvironments: vi.fn(),
    createEnvironment: vi.fn(),
    getEnvironmentById: vi.fn(),
    updateEnvironment: vi.fn(),
    deleteEnvironment: vi.fn(),
    getInstance: vi.fn(),
  },
  mockPrisma: {
    environment: {
      findFirst: vi.fn(),
    },
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
    getLogger: vi.fn(function() { return mockLoggerInstance; }),
    buildPinoHttpOptions: vi.fn(() => ({ level: "silent" })),
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    deploymentLogger: vi.fn(function() { return mockLoggerInstance; }),
    loadbalancerLogger: vi.fn(function() { return mockLoggerInstance; }),
    selfBackupLogger: vi.fn(function() { return mockLoggerInstance; }),
    tlsLogger: vi.fn(function() { return mockLoggerInstance; }),
    agentLogger: vi.fn(function() { return mockLoggerInstance; }),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(function() { return mockLoggerInstance; }),
    serializeError: (e: unknown) => e,
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Mock dependencies with implementations
vi.mock('../services/environment/environment-manager', () => ({
  EnvironmentManager: {
    getInstance: () => mockEnvironmentManager,
  },
}));
vi.mock('../lib/prisma', () => ({
  default: mockPrisma,
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

describe('Environment API', () => {
  const mockEnvironment = {
    id: 'env-1',
    name: 'test-environment',
    description: 'Test environment',
    type: 'nonproduction',
    networkType: 'local',
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
    mockPrisma.environment.findFirst.mockResolvedValue(null);
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
        undefined, 1, 20
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
      mockEnvironmentManager.createEnvironment.mockResolvedValue(mockEnvironment);

      const createRequest = {
        name: 'new-environment',
        description: 'New test environment',
        type: 'nonproduction',
        networkType: 'internet',
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
      mockEnvironmentManager.deleteEnvironment.mockResolvedValue(true);

      await request(app)
        .delete('/api/environments/env-1')
        .expect(204);

      expect(mockEnvironmentManager.deleteEnvironment).toHaveBeenCalledWith('env-1', {
        deleteNetworks: false,
        userId: 'test-user'
      });
    });

    it('should return 404 for non-existent environment', async () => {
      mockEnvironmentManager.deleteEnvironment.mockResolvedValue(false);

      await request(app)
        .delete('/api/environments/non-existent')
        .expect(404);
    });

  });

});
