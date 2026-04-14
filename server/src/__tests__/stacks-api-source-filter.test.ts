import supertest from 'supertest';
import express from 'express';

// Mock prisma
const mockFindMany = vi.fn();
vi.mock('../lib/prisma', () => ({
  default: {
    stack: {
      findMany: (...args: any[]) => mockFindMany(...args),
    },
  },
}));

// Mock logger factory
vi.mock('../lib/logger-factory', () => {
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function () {
      return mockLogger;
    }),
  };
  return {
    createLogger: vi.fn(() => mockLogger),
    appLogger: vi.fn(() => mockLogger),
    httpLogger: vi.fn(() => mockLogger),
    prismaLogger: vi.fn(() => mockLogger),
    servicesLogger: vi.fn(() => mockLogger),
    dockerExecutorLogger: vi.fn(() => mockLogger),
    deploymentLogger: vi.fn(() => mockLogger),
    loadbalancerLogger: vi.fn(() => mockLogger),
    tlsLogger: vi.fn(() => mockLogger),
    agentLogger: vi.fn(() => mockLogger),
  };
});

// Mock auth middleware
vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.user = { id: 'test-user' };
    next();
  },
}));

// Mock socket
vi.mock('../lib/socket', () => ({
  emitToChannel: vi.fn(),
}));

// Mock services that the stacks route imports
vi.mock('../services/docker-executor', () => ({
  DockerExecutorService: vi.fn(),
}));
vi.mock('../services/stacks/stack-reconciler', () => ({
  StackReconciler: vi.fn(),
}));
vi.mock('../services/stacks/stack-routing-manager', () => ({
  StackRoutingManager: vi.fn(),
}));
vi.mock('../services/haproxy', () => ({
  HAProxyFrontendManager: vi.fn(),
}));
vi.mock('../services/haproxy/haproxy-post-apply', () => ({
  restoreHAProxyRuntimeState: vi.fn(),
}));
vi.mock('../services/monitoring', () => ({
  MonitoringService: vi.fn(),
}));

import stackRoutes from '../routes/stacks/index';

function makeStack(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    id: 'stack-1',
    name: 'test-stack',
    description: null,
    environmentId: null,
    version: 1,
    status: 'undeployed',
    lastAppliedVersion: null,
    lastAppliedAt: null,
    lastAppliedSnapshot: null,
    builtinVersion: null,
    templateId: null,
    templateVersion: null,
    parameters: [],
    parameterValues: {},
    networks: [],
    volumes: [],
    removedAt: null,
    createdAt: now,
    updatedAt: now,
    services: [],
    template: null,
    ...overrides,
  };
}

describe('GET /api/stacks - source filtering', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/stacks', stackRoutes);
  });

  it('returns all non-removed stacks when no filters are provided', async () => {
    mockFindMany.mockResolvedValue([makeStack()]);

    const res = await supertest(app).get('/api/stacks').expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where).toEqual({});
    // No OR clause when no scope or environmentId
    expect(call.where.OR).toBeUndefined();
  });

  it('excludes user stacks by default when scope=host', async () => {
    mockFindMany.mockResolvedValue([makeStack()]);

    await supertest(app).get('/api/stacks?scope=host').expect(200);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where.environmentId).toBeNull();
    expect(call.where.OR).toEqual([
      { template: { source: 'system' } },
      { templateId: null },
    ]);
  });

  it('excludes user stacks by default when environmentId is provided', async () => {
    mockFindMany.mockResolvedValue([makeStack({ environmentId: 'env-1' })]);

    await supertest(app).get('/api/stacks?environmentId=env-1').expect(200);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where.environmentId).toBe('env-1');
    expect(call.where.OR).toEqual([
      { template: { source: 'system' } },
      { templateId: null },
    ]);
  });

  it('filters to only user stacks when source=user', async () => {
    const userStack = makeStack({
      templateId: 'tpl-1',
      template: { source: 'user', currentVersion: { version: 1 } },
    });
    mockFindMany.mockResolvedValue([userStack]);

    const res = await supertest(app).get('/api/stacks?source=user').expect(200);

    expect(res.body.success).toBe(true);
    const call = mockFindMany.mock.calls[0][0];
    expect(call.where.template).toEqual({ source: 'user' });
    // No OR clause when source is explicitly set
    expect(call.where.OR).toBeUndefined();
  });

  it('filters to system stacks when source=system', async () => {
    mockFindMany.mockResolvedValue([makeStack()]);

    await supertest(app).get('/api/stacks?source=system').expect(200);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { template: { source: 'system' } },
      { templateId: null },
    ]);
    // No direct template filter
    expect(call.where.template).toBeUndefined();
  });

  it('source=user takes precedence over scope=host exclusion', async () => {
    const userStack = makeStack({
      environmentId: null,
      templateId: 'tpl-1',
      template: { source: 'user', currentVersion: { version: 1 } },
    });
    mockFindMany.mockResolvedValue([userStack]);

    const res = await supertest(app).get('/api/stacks?scope=host&source=user').expect(200);

    expect(res.body.success).toBe(true);
    const call = mockFindMany.mock.calls[0][0];
    // source=user filter should be applied
    expect(call.where.template).toEqual({ source: 'user' });
    // No OR clause - source=user takes precedence
    expect(call.where.OR).toBeUndefined();
  });

  it('includes template.source in the Prisma include', async () => {
    mockFindMany.mockResolvedValue([]);

    await supertest(app).get('/api/stacks').expect(200);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.include.template.select.source).toBe(true);
    expect(call.include.template.select.currentVersion).toEqual({ select: { version: true } });
  });

  it('user stack does not appear in host listing (integration scenario)', async () => {
    // Simulate: prisma returns nothing because the where clause filters out user stacks
    mockFindMany.mockResolvedValue([]);

    const res = await supertest(app).get('/api/stacks?scope=host').expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(0);

    // Verify the where clause would exclude user-template stacks
    const call = mockFindMany.mock.calls[0][0];
    expect(call.where).toEqual({
      environmentId: null,
      OR: [
        { template: { source: 'system' } },
        { templateId: null },
      ],
    });
  });
});
