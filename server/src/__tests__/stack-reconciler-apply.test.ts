import { StackReconciler } from '../services/stacks/stack-reconciler';
import { computeDefinitionHash } from '../services/stacks/definition-hash';
import { buildTemplateContext, resolveStackConfigFiles } from '../services/stacks/template-engine';
import {
  StackServiceDefinition,
  StackConfigFile,
  StackContainerConfig,
  StackDefinition,
} from '@mini-infra/types';

// --- Test data factories ---

function makeServiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'svc-1',
    stackId: 'stack-1',
    serviceName: 'loki',
    serviceType: 'Stateful',
    dockerImage: 'grafana/loki',
    dockerTag: '2.9.0',
    containerConfig: {
      env: { LOG_LEVEL: 'info' },
      restartPolicy: 'unless-stopped',
      ports: [{ containerPort: 3100, hostPort: 3100, protocol: 'tcp' }],
      mounts: [{ source: 'loki_data', target: '/loki', type: 'volume' }],
    },
    configFiles: [
      { volumeName: 'config', path: '/etc/loki/config.yaml', content: 'server:\n  http_listen_port: 3100' },
    ],
    initCommands: [
      { volumeName: 'data', mountPath: '/loki', commands: ['chown 10001:10001 /loki'] },
    ],
    dependsOn: [],
    order: 1,
    routing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStackRow(serviceOverrides: Record<string, unknown>[] = [{}]) {
  const services = serviceOverrides.map((o, i) =>
    makeServiceRow({ id: `svc-${i + 1}`, ...o })
  );
  return {
    id: 'stack-1',
    name: 'monitoring',
    description: null,
    environmentId: 'env-1',
    version: 2,
    status: 'pending',
    lastAppliedVersion: 1,
    lastAppliedAt: new Date(),
    lastAppliedSnapshot: null as StackDefinition | null,
    networks: [{ name: 'monitoring_network' }],
    volumes: [{ name: 'loki_data' }],
    createdAt: new Date(),
    updatedAt: new Date(),
    environment: { id: 'env-1', name: 'prod' },
    services,
  };
}

function computeHashForService(
  stack: ReturnType<typeof makeStackRow>,
  svc: ReturnType<typeof makeServiceRow>
) {
  const ctx = buildTemplateContext(
    { name: stack.name, networks: stack.networks, volumes: stack.volumes },
    stack.services.map((s) => ({
      serviceName: s.serviceName,
      dockerImage: s.dockerImage,
      dockerTag: s.dockerTag,
      containerConfig: s.containerConfig as StackContainerConfig,
    })),
    stack.environment.name
  );
  const resolved = resolveStackConfigFiles(
    (svc.configFiles as StackConfigFile[]) ?? [],
    ctx
  );
  const def: StackServiceDefinition = {
    serviceName: svc.serviceName,
    serviceType: svc.serviceType as 'Stateful',
    dockerImage: svc.dockerImage,
    dockerTag: svc.dockerTag,
    containerConfig: svc.containerConfig as StackContainerConfig,
    configFiles: svc.configFiles as StackConfigFile[],
    initCommands: svc.initCommands as StackServiceDefinition['initCommands'],
    dependsOn: svc.dependsOn as string[],
    order: svc.order,
    routing: undefined,
  };
  return computeDefinitionHash(def, resolved);
}

function makeContainerInfo(
  serviceName: string,
  labels: Record<string, string>,
  image: string,
  state = 'running'
) {
  return {
    Id: `container-${serviceName}`,
    Names: [`/prod-monitoring-${serviceName}`],
    Image: image,
    ImageID: 'sha256:abc',
    Command: '',
    Created: Date.now() / 1000,
    Ports: [],
    Labels: {
      'mini-infra.stack': 'monitoring',
      'mini-infra.stack-id': 'stack-1',
      'mini-infra.service': serviceName,
      'mini-infra.environment': 'env-1',
      ...labels,
    },
    State: state,
    Status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 5 minutes ago',
    HostConfig: { NetworkMode: 'default' },
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };
}

// --- Mocks ---

const mockFindUniqueOrThrow = vi.fn();
const mockStackUpdate = vi.fn();
const mockListContainers = vi.fn();

const mockContainerStart = vi.fn().mockResolvedValue(undefined);
const mockContainerWait = vi.fn().mockResolvedValue({ StatusCode: 0 });
const mockContainerRemove = vi.fn().mockResolvedValue(undefined);
const mockContainerStop = vi.fn().mockResolvedValue(undefined);
const mockContainerInspect = vi.fn().mockResolvedValue({
  Config: { Healthcheck: null },
  State: { Status: 'running', Health: null },
});

const mockCreateContainer = vi.fn().mockResolvedValue({
  id: 'init-container-id',
  start: mockContainerStart,
  wait: mockContainerWait,
  remove: mockContainerRemove,
});

const mockGetContainer = vi.fn().mockReturnValue({
  stop: mockContainerStop,
  remove: mockContainerRemove,
  inspect: mockContainerInspect,
});

const mockPullImageWithAutoAuth = vi.fn().mockResolvedValue(undefined);
const mockNetworkExists = vi.fn().mockResolvedValue(true);
const mockVolumeExists = vi.fn().mockResolvedValue(true);
const mockCreateNetwork = vi.fn().mockResolvedValue(undefined);
const mockCreateVolume = vi.fn().mockResolvedValue(undefined);
const mockGetContainerStatus = vi.fn().mockResolvedValue({ status: 'running', running: true });

const mockLongRunningContainer = {
  id: 'new-container-id',
  start: vi.fn().mockResolvedValue(undefined),
};
const mockCreateLongRunningContainer = vi.fn().mockResolvedValue(mockLongRunningContainer);

const mockPrisma = {
  stack: {
    findUniqueOrThrow: mockFindUniqueOrThrow,
    update: mockStackUpdate,
  },
} as any;

const mockDockerExecutor = {
  getDockerClient: () => ({
    listContainers: mockListContainers,
    createContainer: mockCreateContainer,
    getContainer: mockGetContainer,
  }),
  pullImageWithAutoAuth: mockPullImageWithAutoAuth,
  createLongRunningContainer: mockCreateLongRunningContainer,
  getContainerStatus: mockGetContainerStatus,
  networkExists: mockNetworkExists,
  volumeExists: mockVolumeExists,
  createNetwork: mockCreateNetwork,
  createVolume: mockCreateVolume,
} as any;

// --- Tests ---

describe('StackReconciler.apply', () => {
  let reconciler: StackReconciler;

  beforeEach(() => {
    vi.clearAllMocks();
    reconciler = new StackReconciler(mockDockerExecutor, mockPrisma);
    mockStackUpdate.mockResolvedValue({});
    mockContainerInspect.mockResolvedValue({
      Config: { Healthcheck: null },
      State: { Status: 'running', Health: null },
    });
  });

  it('creates a new service — pulls, writes config, inits, creates container, updates DB', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);

    // plan() call
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(true);
    expect(result.serviceResults).toHaveLength(1);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'loki',
      action: 'create',
      success: true,
    });
    expect(result.serviceResults[0].containerId).toBe('new-container-id');

    // Verify pull was called
    expect(mockPullImageWithAutoAuth).toHaveBeenCalledWith('grafana/loki:2.9.0');

    // Verify container was created and started
    expect(mockCreateLongRunningContainer).toHaveBeenCalledTimes(1);
    expect(mockLongRunningContainer.start).toHaveBeenCalled();

    // Verify init commands were run (alpine container created)
    expect(mockCreateContainer).toHaveBeenCalled();

    // Verify DB updated
    expect(mockStackUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stack-1' },
        data: expect.objectContaining({
          lastAppliedVersion: 2,
          status: 'synced',
        }),
      })
    );
  });

  it('recreates a service — stops old, creates new, removes old on success', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);

    // Return a container with stale hash
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': 'sha256:stale' }, 'grafana/loki:2.9.0'),
    ]);

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(true);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'loki',
      action: 'recreate',
      success: true,
    });

    // Old container stopped and removed
    expect(mockContainerStop).toHaveBeenCalled();
    expect(mockContainerRemove).toHaveBeenCalled();

    // New container created
    expect(mockCreateLongRunningContainer).toHaveBeenCalledTimes(1);
  });

  it('removes a service — stops and removes container', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    const svc = stack.services[0];
    const hash = computeHashForService(stack, svc);

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    // Loki is synced, but there's an orphaned prometheus container
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': hash }, 'grafana/loki:2.9.0'),
      makeContainerInfo('prometheus', {}, 'prom/prometheus:v3.3.0'),
    ]);

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(true);
    const removeResult = result.serviceResults.find((r) => r.serviceName === 'prometheus');
    expect(removeResult).toMatchObject({ action: 'remove', success: true });

    // Container should have been stopped/removed
    expect(mockContainerStop).toHaveBeenCalled();
  });

  it('filters to specified serviceNames', async () => {
    const stack = makeStackRow([
      { serviceName: 'loki' },
      { serviceName: 'prometheus', id: 'svc-2', dockerImage: 'prom/prometheus', dockerTag: 'v3.3.0', configFiles: [], initCommands: [] },
    ]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const result = await reconciler.apply('stack-1', { serviceNames: ['loki'] });

    // Only loki should be applied
    expect(result.serviceResults).toHaveLength(1);
    expect(result.serviceResults[0].serviceName).toBe('loki');
  });

  it('returns plan without executing on dry run', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const result = await reconciler.apply('stack-1', { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.serviceResults).toHaveLength(1);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'loki',
      action: 'create',
      duration: 0,
    });

    // No Docker operations should have been executed
    expect(mockPullImageWithAutoAuth).not.toHaveBeenCalled();
    expect(mockCreateLongRunningContainer).not.toHaveBeenCalled();
    expect(mockStackUpdate).not.toHaveBeenCalled();
  });

  it('marks service as failed on healthcheck timeout', async () => {
    const stack = makeStackRow([{
      serviceName: 'loki',
      configFiles: [],
      initCommands: [],
    }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    // Container has a healthcheck
    mockContainerInspect.mockResolvedValue({
      Config: { Healthcheck: { Test: ['CMD', 'curl', '-f', 'http://localhost:3100/ready'] } },
      State: { Status: 'running', Health: { Status: 'starting' } },
    });

    // Override waitForHealthy by making inspect always return 'starting'
    // and use a short timeout — we'll mock the timeout behavior
    const originalApply = reconciler.apply.bind(reconciler);

    // Instead, let's make getContainerStatus indicate unhealthy
    // The healthcheck poll will timeout. We need to mock inspect to return unhealthy
    let callCount = 0;
    mockContainerInspect.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        Config: { Healthcheck: { Test: ['CMD', 'curl', '-f', 'http://localhost:3100/ready'] } },
        State: { Status: 'running', Health: { Status: callCount > 2 ? 'unhealthy' : 'starting' } },
      });
    });

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(false);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'loki',
      action: 'create',
      success: false,
      error: 'Healthcheck timeout',
    });

    // DB status should be error
    expect(mockStackUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'error' }),
      })
    );
  });

  it('updates DB with correct fields on success', async () => {
    const stack = makeStackRow([{
      serviceName: 'loki',
      configFiles: [],
      initCommands: [],
    }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    await reconciler.apply('stack-1');

    expect(mockStackUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stack-1' },
        data: expect.objectContaining({
          lastAppliedVersion: 2,
          lastAppliedAt: expect.any(Date),
          lastAppliedSnapshot: expect.objectContaining({
            name: 'monitoring',
            services: expect.any(Array),
          }),
          status: 'synced',
        }),
      })
    );
  });

  it('handles partial failure — one service fails, others succeed, status = error', async () => {
    const stack = makeStackRow([
      { serviceName: 'loki', configFiles: [], initCommands: [] },
      {
        serviceName: 'prometheus',
        id: 'svc-2',
        dockerImage: 'prom/prometheus',
        dockerTag: 'v3.3.0',
        configFiles: [],
        initCommands: [],
        containerConfig: { env: {} },
      },
    ]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    // First call succeeds, second fails
    let callNum = 0;
    mockCreateLongRunningContainer.mockImplementation(() => {
      callNum++;
      if (callNum === 2) {
        return Promise.reject(new Error('Port conflict'));
      }
      return Promise.resolve({
        id: `container-${callNum}`,
        start: vi.fn().mockResolvedValue(undefined),
      });
    });

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(false);
    expect(result.serviceResults.filter((r) => r.success)).toHaveLength(1);
    expect(result.serviceResults.filter((r) => !r.success)).toHaveLength(1);
    expect(result.serviceResults.find((r) => !r.success)?.error).toBe('Port conflict');

    expect(mockStackUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'error' }),
      })
    );
  });

  it('runs init commands via alpine container with volume mount', async () => {
    const stack = makeStackRow([{
      serviceName: 'loki',
      configFiles: [],
      initCommands: [
        { volumeName: 'data', mountPath: '/loki', commands: ['chown 10001:10001 /loki'] },
      ],
    }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    await reconciler.apply('stack-1');

    // Verify alpine container was created with correct volume bind
    const initCall = mockCreateContainer.mock.calls.find(
      (call: any[]) => call[0].name?.includes('-init-')
    );
    expect(initCall).toBeDefined();
    expect(initCall![0].Image).toBe('alpine:latest');
    expect(initCall![0].Cmd).toEqual(['sh', '-c', 'chown 10001:10001 /loki']);
    expect(initCall![0].HostConfig.Binds[0]).toContain('data:/loki');
  });

  it('writes config files via alpine container with escaped content', async () => {
    const stack = makeStackRow([{
      serviceName: 'loki',
      initCommands: [],
      configFiles: [
        { volumeName: 'config', path: '/etc/loki/config.yaml', content: "server:\n  port: 3100" },
      ],
    }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    await reconciler.apply('stack-1');

    // Verify config writer container was created
    const configCall = mockCreateContainer.mock.calls.find(
      (call: any[]) => call[0].name?.includes('-config-writer-')
    );
    expect(configCall).toBeDefined();
    expect(configCall![0].Image).toBe('alpine:latest');
    expect(configCall![0].Cmd[2]).toContain('/etc/loki/config.yaml');
    expect(configCall![0].HostConfig.Binds[0]).toContain('config:/vol');
  });

  it('creates networks and volumes if they do not exist', async () => {
    const stack = makeStackRow([{
      serviceName: 'loki',
      configFiles: [],
      initCommands: [],
    }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);
    mockNetworkExists.mockResolvedValue(false);
    mockVolumeExists.mockResolvedValue(false);

    await reconciler.apply('stack-1');

    expect(mockCreateNetwork).toHaveBeenCalledWith(
      'prod-monitoring_monitoring_network',
      'prod-monitoring',
      expect.objectContaining({ labels: expect.any(Object) })
    );
    expect(mockCreateVolume).toHaveBeenCalledWith(
      'prod-monitoring_loki_data',
      'prod-monitoring',
      expect.objectContaining({ labels: expect.any(Object) })
    );
  });
});
