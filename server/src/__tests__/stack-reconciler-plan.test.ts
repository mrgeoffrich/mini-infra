import { StackReconciler } from '../services/stacks/stack-reconciler';
import { StackResourceReconciler } from '../services/stacks/stack-resource-reconciler';
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
    containerConfig: { env: { LOG_LEVEL: 'info' }, restartPolicy: 'unless-stopped' },
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
const mockListContainers = vi.fn();

const mockPrisma = {
  stack: { findUniqueOrThrow: mockFindUniqueOrThrow },
  stackResource: { findMany: vi.fn().mockResolvedValue([]) },
} as any;

const mockDockerExecutor = {
  getDockerClient: () => ({ listContainers: mockListContainers }),
} as any;

// --- Tests ---

describe('StackReconciler.plan', () => {
  let reconciler: StackReconciler;

  beforeEach(() => {
    vi.clearAllMocks();
    reconciler = new StackReconciler(mockDockerExecutor, mockPrisma);
  });

  it('returns all create actions when no containers exist', async () => {
    const stack = makeStackRow([
      { serviceName: 'loki' },
      { serviceName: 'prometheus', id: 'svc-2', dockerImage: 'prom/prometheus', dockerTag: 'v3.3.0' },
    ]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const plan = await reconciler.plan('stack-1');

    expect(plan.hasChanges).toBe(true);
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toMatchObject({ serviceName: 'loki', action: 'create' });
    expect(plan.actions[1]).toMatchObject({ serviceName: 'prometheus', action: 'create' });
    expect(plan.stackName).toBe('monitoring');
    expect(plan.stackVersion).toBe(2);
  });

  it('returns all no-op actions when all containers are synced', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    const svc = stack.services[0];
    const hash = computeHashForService(stack, svc);

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': hash }, 'grafana/loki:2.9.0'),
    ]);

    const plan = await reconciler.plan('stack-1');

    expect(plan.hasChanges).toBe(false);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ serviceName: 'loki', action: 'no-op' });
  });

  it('detects image tag change as recreate', async () => {
    const stack = makeStackRow([{ serviceName: 'loki', dockerTag: '3.0.0' }]);
    // Container has old tag hash
    const oldHash = 'sha256:oldoldhash';

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': oldHash }, 'grafana/loki:2.9.0'),
    ]);

    const plan = await reconciler.plan('stack-1');

    expect(plan.hasChanges).toBe(true);
    const action = plan.actions.find((a) => a.serviceName === 'loki');
    expect(action).toMatchObject({
      action: 'recreate',
      currentImage: 'grafana/loki:2.9.0',
      desiredImage: 'grafana/loki:3.0.0',
    });
    expect(action?.reason).toContain('image changed');
  });

  it('detects config file content change as recreate', async () => {
    const stack = makeStackRow([{
      serviceName: 'loki',
      configFiles: [
        { volumeName: 'config', path: '/etc/loki/config.yaml', content: 'NEW CONTENT' },
      ],
    }]);
    // Give it a snapshot with the old config
    stack.lastAppliedSnapshot = {
      name: 'monitoring',
      networks: [{ name: 'monitoring_network' }],
      volumes: [{ name: 'loki_data' }],
      services: [{
        serviceName: 'loki',
        serviceType: 'Stateful',
        dockerImage: 'grafana/loki',
        dockerTag: '2.9.0',
        containerConfig: { env: { LOG_LEVEL: 'info' }, restartPolicy: 'unless-stopped' },
        configFiles: [
          { volumeName: 'config', path: '/etc/loki/config.yaml', content: 'OLD CONTENT' },
        ],
        initCommands: [{ volumeName: 'data', mountPath: '/loki', commands: ['chown 10001:10001 /loki'] }],
        dependsOn: [],
        order: 1,
      }],
    };

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': 'sha256:stale' }, 'grafana/loki:2.9.0'),
    ]);

    const plan = await reconciler.plan('stack-1');

    const action = plan.actions.find((a) => a.serviceName === 'loki');
    expect(action?.action).toBe('recreate');
    expect(action?.reason).toContain('configuration changed');
    expect(action?.diff?.some((d) => d.field === 'configFiles')).toBe(true);
  });

  it('detects removed services as remove action', async () => {
    // Stack has only loki defined, but there's a prometheus container running
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    const svc = stack.services[0];
    const hash = computeHashForService(stack, svc);

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': hash }, 'grafana/loki:2.9.0'),
      makeContainerInfo('prometheus', {}, 'prom/prometheus:v3.3.0'),
    ]);

    const plan = await reconciler.plan('stack-1');

    expect(plan.hasChanges).toBe(true);
    const removeAction = plan.actions.find((a) => a.serviceName === 'prometheus');
    expect(removeAction).toMatchObject({
      action: 'remove',
      reason: 'service removed from definition',
      currentImage: 'prom/prometheus:v3.3.0',
    });
  });

  it('handles mixed scenario: create, recreate, no-op, remove', async () => {
    const stack = makeStackRow([
      { serviceName: 'loki' },
      { serviceName: 'alloy', id: 'svc-2', dockerImage: 'grafana/alloy', dockerTag: '2.0.0', configFiles: [], initCommands: [] },
      { serviceName: 'telegraf', id: 'svc-3', dockerImage: 'telegraf', dockerTag: '1.33', configFiles: [], initCommands: [] },
    ]);

    const lokiHash = computeHashForService(stack, stack.services[0]);

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([
      // loki is synced
      makeContainerInfo('loki', { 'mini-infra.definition-hash': lokiHash }, 'grafana/loki:2.9.0'),
      // alloy has stale hash (recreate)
      makeContainerInfo('alloy', { 'mini-infra.definition-hash': 'sha256:stale' }, 'grafana/alloy:2.0.0'),
      // old-service is orphaned (remove)
      makeContainerInfo('old-service', {}, 'some/image:1.0'),
      // telegraf is missing → will be create (not in container list)
    ]);

    const plan = await reconciler.plan('stack-1');

    expect(plan.hasChanges).toBe(true);
    expect(plan.actions.find((a) => a.serviceName === 'loki')?.action).toBe('no-op');
    expect(plan.actions.find((a) => a.serviceName === 'alloy')?.action).toBe('recreate');
    expect(plan.actions.find((a) => a.serviceName === 'telegraf')?.action).toBe('create');
    expect(plan.actions.find((a) => a.serviceName === 'old-service')?.action).toBe('remove');
  });

  it('marks stopped container as recreate', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    const svc = stack.services[0];
    const hash = computeHashForService(stack, svc);

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': hash }, 'grafana/loki:2.9.0', 'exited'),
    ]);

    const plan = await reconciler.plan('stack-1');

    const action = plan.actions.find((a) => a.serviceName === 'loki');
    expect(action?.action).toBe('recreate');
    expect(action?.reason).toBe('container not running');
  });

  it('detects env var change in containerConfig', async () => {
    const stack = makeStackRow([{
      serviceName: 'loki',
      containerConfig: { env: { LOG_LEVEL: 'debug' }, restartPolicy: 'unless-stopped' },
    }]);
    stack.lastAppliedSnapshot = {
      name: 'monitoring',
      networks: [{ name: 'monitoring_network' }],
      volumes: [{ name: 'loki_data' }],
      services: [{
        serviceName: 'loki',
        serviceType: 'Stateful',
        dockerImage: 'grafana/loki',
        dockerTag: '2.9.0',
        containerConfig: { env: { LOG_LEVEL: 'info' }, restartPolicy: 'unless-stopped' },
        configFiles: [
          { volumeName: 'config', path: '/etc/loki/config.yaml', content: 'server:\n  http_listen_port: 3100' },
        ],
        initCommands: [{ volumeName: 'data', mountPath: '/loki', commands: ['chown 10001:10001 /loki'] }],
        dependsOn: [],
        order: 1,
      }],
    };

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([
      makeContainerInfo('loki', { 'mini-infra.definition-hash': 'sha256:stale' }, 'grafana/loki:2.9.0'),
    ]);

    const plan = await reconciler.plan('stack-1');

    const action = plan.actions.find((a) => a.serviceName === 'loki');
    expect(action?.action).toBe('recreate');
    expect(action?.diff?.some((d) => d.field === 'containerConfig')).toBe(true);
  });

  it('throws when stack not found', async () => {
    mockFindUniqueOrThrow.mockRejectedValue(new Error('No Stack found'));

    await expect(reconciler.plan('nonexistent')).rejects.toThrow('No Stack found');
  });

  it('includes stackId, stackName, and planTime in result', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const plan = await reconciler.plan('stack-1');

    expect(plan.stackId).toBe('stack-1');
    expect(plan.stackName).toBe('monitoring');
    expect(plan.stackVersion).toBe(2);
    expect(plan.planTime).toBeDefined();
    expect(() => new Date(plan.planTime)).not.toThrow();
  });

  it('returns empty resourceActions when no resource reconciler is provided', async () => {
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    const plan = await reconciler.plan('stack-1');

    expect(plan.resourceActions).toEqual([]);
  });

  it('plans resource actions for TLS and DNS when resource reconciler is provided', async () => {
    // Create stack with resource definitions
    const stack = makeStackRow([{ serviceName: 'loki' }]);
    stack.tlsCertificates = [{ name: 'app-cert', fqdn: 'app.example.com' }] as any;
    stack.dnsRecords = [{ name: 'app-dns', fqdn: 'app.example.com', recordType: 'A', target: '1.2.3.4' }] as any;

    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);
    // stackResource.findMany returns empty = no current resources = all creates
    mockPrisma.stackResource.findMany.mockResolvedValue([]);

    // Create a real resource reconciler (planResources is synchronous, no external calls)
    const mockResourceReconciler = new StackResourceReconciler(
      mockPrisma,
      {} as any, // certLifecycleManager (not used in plan)
      {} as any, // cloudflareDns (not used in plan)
      {} as any, // haproxyCertDeployer (not used in plan)
    );

    const reconcilerWithResources = new StackReconciler(
      mockDockerExecutor,
      mockPrisma,
      undefined,
      mockResourceReconciler,
    );

    const plan = await reconcilerWithResources.plan('stack-1');

    // Verify plan includes resource create actions
    expect(plan.resourceActions).toHaveLength(2);
    expect(plan.resourceActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'tls', resourceName: 'app-cert', action: 'create' }),
        expect.objectContaining({ resourceType: 'dns', resourceName: 'app-dns', action: 'create' }),
      ]),
    );
    expect(plan.hasChanges).toBe(true);
  });
});
