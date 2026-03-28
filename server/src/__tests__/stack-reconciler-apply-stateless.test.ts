import { StackReconciler } from '../services/stacks/stack-reconciler';
import { StackRoutingManager, StackRoutingContext } from '../services/stacks/stack-routing-manager';
import { computeDefinitionHash } from '../services/stacks/definition-hash';
import { buildTemplateContext, resolveStackConfigFiles } from '../services/stacks/template-engine';
import {
  StackServiceDefinition,
  StackConfigFile,
  StackContainerConfig,
  StackDefinition,
} from '@mini-infra/types';

// Mock runStateMachineToCompletion so StatelessWeb services go through state machine
const mockRunStateMachine = vi.fn();
vi.mock('../services/stacks/state-machine-runner', () => ({
  runStateMachineToCompletion: (...args: any[]) => mockRunStateMachine(...args),
}));

// Mock EnvironmentValidationService used by buildStateMachineContext
vi.mock('../services/environment', () => ({
  EnvironmentValidationService: class {
    getHAProxyEnvironmentContext = vi.fn().mockResolvedValue({
      environmentId: 'env-1',
      environmentName: 'prod',
      haproxyContainerId: 'haproxy-container-id',
      haproxyNetworkName: 'haproxy_network',
    });
  },
}));

// --- Test data factories ---

function makeStatelessWebServiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'svc-web-1',
    stackId: 'stack-1',
    serviceName: 'web-app',
    serviceType: 'StatelessWeb',
    dockerImage: 'myapp/web',
    dockerTag: '1.0.0',
    containerConfig: {
      env: { NODE_ENV: 'production' },
      restartPolicy: 'unless-stopped',
    } as StackContainerConfig,
    configFiles: [],
    initCommands: [],
    dependsOn: [],
    order: 1,
    routing: {
      hostname: 'app.example.com',
      listeningPort: 3000,
      backendOptions: { balanceAlgorithm: 'roundrobin' },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStatefulServiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'svc-db-1',
    stackId: 'stack-1',
    serviceName: 'redis',
    serviceType: 'Stateful',
    dockerImage: 'redis',
    dockerTag: '7.0',
    containerConfig: {
      env: {},
      restartPolicy: 'unless-stopped',
      ports: [{ containerPort: 6379, hostPort: 6379, protocol: 'tcp' }],
    } as StackContainerConfig,
    configFiles: [],
    initCommands: [],
    dependsOn: [],
    order: 2,
    routing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStackRow(serviceOverrides: Record<string, unknown>[] = [{}]) {
  const services = serviceOverrides.map((o, i) => {
    const base = (o as any).serviceType === 'Stateful'
      ? makeStatefulServiceRow({ id: `svc-${i + 1}`, ...o })
      : makeStatelessWebServiceRow({ id: `svc-${i + 1}`, ...o });
    return base;
  });
  return {
    id: 'stack-1',
    name: 'webapp',
    description: null,
    environmentId: 'env-1',
    version: 2,
    status: 'pending',
    lastAppliedVersion: 1,
    lastAppliedAt: new Date(),
    lastAppliedSnapshot: null as StackDefinition | null,
    networks: [{ name: 'app_network' }],
    volumes: [],
    tlsCertificates: [],
    dnsRecords: [],
    tunnelIngress: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    environment: { id: 'env-1', name: 'prod' },
    services,
  };
}

function computeHashForService(
  stack: ReturnType<typeof makeStackRow>,
  svc: ReturnType<typeof makeStatelessWebServiceRow>
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
    serviceType: svc.serviceType as any,
    dockerImage: svc.dockerImage,
    dockerTag: svc.dockerTag,
    containerConfig: svc.containerConfig as StackContainerConfig,
    configFiles: svc.configFiles as StackConfigFile[],
    initCommands: svc.initCommands as StackServiceDefinition['initCommands'],
    dependsOn: svc.dependsOn as string[],
    order: svc.order,
    routing: svc.routing as StackServiceDefinition['routing'],
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
    Names: [`/prod-webapp-${serviceName}`],
    Image: image,
    ImageID: 'sha256:abc',
    Command: '',
    Created: Date.now() / 1000,
    Ports: [],
    Labels: {
      'mini-infra.stack': 'webapp',
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

const mockNetworkConnect = vi.fn().mockResolvedValue(undefined);
const mockGetNetwork = vi.fn().mockReturnValue({
  connect: mockNetworkConnect,
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

const mockStackDeploymentCreate = vi.fn().mockResolvedValue({});
const mockStackResourceFindFirst = vi.fn().mockResolvedValue(null);
const mockPrisma = {
  stack: {
    findUniqueOrThrow: mockFindUniqueOrThrow,
    update: mockStackUpdate,
  },
  stackDeployment: {
    create: mockStackDeploymentCreate,
  },
  stackResource: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: mockStackResourceFindFirst,
  },
} as any;

const mockDockerExecutor = {
  getDockerClient: () => ({
    listContainers: mockListContainers,
    createContainer: mockCreateContainer,
    getContainer: mockGetContainer,
    getNetwork: mockGetNetwork,
  }),
  pullImageWithAutoAuth: mockPullImageWithAutoAuth,
  createLongRunningContainer: mockCreateLongRunningContainer,
  getContainerStatus: mockGetContainerStatus,
  networkExists: mockNetworkExists,
  volumeExists: mockVolumeExists,
  createNetwork: mockCreateNetwork,
  createVolume: mockCreateVolume,
} as any;

// Mock StackRoutingManager
const mockGetHAProxyContext = vi.fn().mockResolvedValue({
  environmentId: 'env-1',
  environmentName: 'prod',
  haproxyContainerId: 'haproxy-container-id',
  haproxyNetworkName: 'haproxy_network',
});
const mockSetupBackendAndServer = vi.fn().mockResolvedValue({
  backendName: 'stk-webapp-web-app',
  serverName: 'web-app-new-cont',
});
const mockConfigureRoute = vi.fn().mockResolvedValue(undefined);
const mockEnableTraffic = vi.fn().mockResolvedValue(undefined);
const mockDrainAndRemoveServer = vi.fn().mockResolvedValue(undefined);
const mockRemoveRoute = vi.fn().mockResolvedValue(undefined);
const mockConfigureDNS = vi.fn().mockResolvedValue(undefined);
const mockRemoveDNS = vi.fn().mockResolvedValue(undefined);

const mockRoutingManager = {
  getHAProxyContext: mockGetHAProxyContext,
  setupBackendAndServer: mockSetupBackendAndServer,
  configureRoute: mockConfigureRoute,
  enableTraffic: mockEnableTraffic,
  drainAndRemoveServer: mockDrainAndRemoveServer,
  removeRoute: mockRemoveRoute,
  configureDNS: mockConfigureDNS,
  removeDNS: mockRemoveDNS,
} as unknown as StackRoutingManager;

// Mock HAProxyDataPlaneClient
vi.mock('../services/haproxy', () => ({
  HAProxyDataPlaneClient: class MockHAProxyDataPlaneClient {
    addServer = vi.fn().mockResolvedValue(undefined);
    deleteServer = vi.fn().mockResolvedValue(undefined);
  },
}));

// --- Tests ---

describe('StackReconciler.apply — StatelessWeb', () => {
  let reconciler: StackReconciler;

  beforeEach(() => {
    vi.clearAllMocks();
    reconciler = new StackReconciler(mockDockerExecutor, mockPrisma, mockRoutingManager);
    mockStackUpdate.mockResolvedValue({});
    mockContainerInspect.mockResolvedValue({
      Config: { Healthcheck: null },
      State: { Status: 'running', Health: null },
    });
    // Default: state machine completes successfully
    mockRunStateMachine.mockResolvedValue({
      value: 'completed',
      status: 'done',
      context: {
        containerId: 'new-container-id',
        newContainerId: 'new-container-id',
        error: undefined,
      },
    });
  });

  it('creates a StatelessWeb service via initial deployment state machine', async () => {
    const stack = makeStackRow([{ serviceName: 'web-app' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const result = await reconciler.apply('stack-1');

    expect(result.serviceResults).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'web-app',
      action: 'create',
      success: true,
      containerId: 'new-container-id',
    });

    // Verify state machine was invoked with initial deployment machine
    expect(mockRunStateMachine).toHaveBeenCalledTimes(1);
    const [machine, context] = mockRunStateMachine.mock.calls[0];
    expect(machine.id).toBe('initialDeployment');
    expect(context).toMatchObject({
      applicationName: expect.stringContaining('stk-webapp-web-app'),
      dockerImage: 'myapp/web:1.0.0',
      hostname: 'app.example.com',
      containerPort: 3000,
      enableSsl: false,
    });
  });

  it('recreates a StatelessWeb service via blue-green deployment state machine', async () => {
    const stack = makeStackRow([{ serviceName: 'web-app' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);

    // Return existing container with stale hash
    mockListContainers.mockResolvedValue([
      makeContainerInfo('web-app', { 'mini-infra.definition-hash': 'sha256:stale' }, 'myapp/web:1.0.0'),
    ]);

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(true);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'web-app',
      action: 'recreate',
      success: true,
      containerId: 'new-container-id',
    });

    // Verify state machine was invoked with blue-green machine
    expect(mockRunStateMachine).toHaveBeenCalledTimes(1);
    const [machine, context] = mockRunStateMachine.mock.calls[0];
    expect(machine.id).toBe('blueGreenDeployment');
    expect(context).toMatchObject({
      oldContainerId: 'container-web-app',
      hostname: 'app.example.com',
    });
  });

  it('removes a StatelessWeb service via removal state machine', async () => {
    const stack = makeStackRow([{ serviceName: 'web-app' }]);
    const svc = stack.services[0];
    const hash = computeHashForService(stack, svc as any);

    const stackWithOrphan = makeStackRow([{ serviceName: 'web-app' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stackWithOrphan);

    // web-app is in sync, plus orphaned old-web
    mockListContainers.mockResolvedValue([
      makeContainerInfo('web-app', { 'mini-infra.definition-hash': hash }, 'myapp/web:1.0.0'),
      makeContainerInfo('old-web', {}, 'myapp/web:0.9.0'),
    ]);

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(true);
    const removeResult = result.serviceResults.find((r) => r.serviceName === 'old-web');
    expect(removeResult).toMatchObject({ action: 'remove', success: true });
  });

  it('handles state machine failure on create — maps rollback state to error result', async () => {
    const stack = makeStackRow([{ serviceName: 'web-app', configFiles: [], initCommands: [] }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    // State machine reaches rollbackComplete (health check failure triggers rollback)
    mockRunStateMachine.mockResolvedValue({
      value: 'rollbackComplete',
      status: 'done',
      context: {
        containerId: undefined,
        error: 'Health check timeout',
      },
    });

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(false);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'web-app',
      action: 'create',
      success: false,
      error: 'Health check timeout',
    });
  });

  it('handles state machine failure on recreate — maps rollback state to error result', async () => {
    const stack = makeStackRow([{ serviceName: 'web-app', configFiles: [], initCommands: [] }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);

    mockListContainers.mockResolvedValue([
      makeContainerInfo('web-app', { 'mini-infra.definition-hash': 'sha256:stale' }, 'myapp/web:0.9.0'),
    ]);

    // State machine reaches rollbackComplete
    mockRunStateMachine.mockResolvedValue({
      value: 'rollbackComplete',
      status: 'done',
      context: {
        newContainerId: undefined,
        error: 'Health check timeout',
      },
    });

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(false);
    expect(result.serviceResults[0]).toMatchObject({
      serviceName: 'web-app',
      action: 'recreate',
      success: false,
      error: 'Health check timeout',
    });

    // Verify blue-green machine was used
    const [machine, context] = mockRunStateMachine.mock.calls[0];
    expect(machine.id).toBe('blueGreenDeployment');
    expect(context.oldContainerId).toBe('container-web-app');
  });

  it('sets networkType to local for all StatelessWeb services', async () => {
    const stack = makeStackRow([{
      serviceName: 'web-app',
      routing: {
        hostname: 'app.example.com',
        listeningPort: 3000,
      },
    }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(true);
    // networkType is always 'local' — DNS is now managed as a stack-level resource
    const [, context] = mockRunStateMachine.mock.calls[0];
    expect(context.networkType).toBe('local');
  });

  it('throws if routingManager not provided for StatelessWeb', async () => {
    const reconcilerNoRouting = new StackReconciler(mockDockerExecutor, mockPrisma);
    const stack = makeStackRow([{ serviceName: 'web-app' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    await expect(reconcilerNoRouting.apply('stack-1')).rejects.toThrow(
      'StackRoutingManager is required for StatelessWeb service "web-app"'
    );
  });

  it('handles mixed Stateful + StatelessWeb services in same stack', async () => {
    const stack = makeStackRow([
      { serviceName: 'web-app', serviceType: 'StatelessWeb' },
      { serviceName: 'redis', serviceType: 'Stateful', dockerImage: 'redis', dockerTag: '7.0', routing: null },
    ]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    // Each service gets a different container ID
    let callNum = 0;
    mockCreateLongRunningContainer.mockImplementation(() => {
      callNum++;
      return Promise.resolve({
        id: `container-${callNum}`,
        start: vi.fn().mockResolvedValue(undefined),
      });
    });

    const result = await reconciler.apply('stack-1');

    expect(result.success).toBe(true);
    expect(result.serviceResults).toHaveLength(2);

    // StatelessWeb uses state machine
    const webResult = result.serviceResults.find((r) => r.serviceName === 'web-app');
    expect(webResult).toMatchObject({ action: 'create', success: true });
    expect(mockRunStateMachine).toHaveBeenCalledTimes(1);

    // Stateful does NOT use state machine — uses procedural path
    const redisResult = result.serviceResults.find((r) => r.serviceName === 'redis');
    expect(redisResult).toMatchObject({ action: 'create', success: true });

    // Stateful container created via procedural path
    expect(mockCreateLongRunningContainer).toHaveBeenCalledTimes(1);
  });
});
