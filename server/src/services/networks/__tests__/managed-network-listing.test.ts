import { listManagedNetworks } from '../managed-network-listing';

let selfContainerId: string | null = 'self-container-id';
vi.mock('../../self-update', () => ({
  getOwnContainerId: () => selfContainerId,
}));

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

// ---------------------------------------------------------------------------
// Fake Prisma — mirrors network-reconciler.test.ts's in-memory-table pattern
// (this module shares the reconciler's exact query shapes for drift
// counting, plus a few extra reads of its own — user/environment/stack name
// lookups).
// ---------------------------------------------------------------------------
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && 'in' in (cond as object)) {
      return (cond as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === cond;
  });
}

interface Fixtures {
  stacks?: Array<{ id: string; name: string; services: Array<{ id: string; serviceName: string; serviceType: string; adoptedContainer?: unknown }>; removedAt?: string | null }>;
  environments?: Array<{ id: string; name: string }>;
  managedNetworks?: Array<Record<string, unknown>>;
  networkMemberships?: Array<Record<string, unknown>>;
  users?: Array<{ id: string; name?: string | null; email: string }>;
}

function makeMockPrisma(fixtures: Fixtures) {
  const stacks = fixtures.stacks ?? [];
  const environments = fixtures.environments ?? [];
  const managedNetworks = fixtures.managedNetworks ?? [];
  const networkMemberships = fixtures.networkMemberships ?? [];
  const users = fixtures.users ?? [];
  const stackServices = stacks.flatMap((s) =>
    s.services.map((svc) => ({ id: svc.id, stackId: s.id, serviceName: svc.serviceName, stack: { name: s.name } })),
  );

  return {
    stack: {
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const found = stacks.find((s) => s.id === where.id);
        if (!found) throw new Error(`stack ${where.id} not found`);
        return found;
      }),
      findMany: vi.fn(async ({ where }: any) => stacks.filter((s) => matches(s as any, where))),
    },
    environment: {
      findMany: vi.fn(async ({ where }: any) => (where ? environments.filter((e) => matches(e as any, where)) : environments)),
    },
    managedNetwork: {
      findMany: vi.fn(async ({ where }: any) => managedNetworks.filter((n) => matches(n, where))),
    },
    networkMembership: {
      findMany: vi.fn(async ({ where }: any) => networkMemberships.filter((m) => matches(m, where))),
    },
    stackService: {
      findMany: vi.fn(async ({ where }: any) => stackServices.filter((s) => matches(s as any, where))),
    },
    user: {
      findMany: vi.fn(async ({ where }: any) => users.filter((u) => matches(u as any, where))),
    },
  } as any;
}

function net(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'net-1',
    scope: 'host',
    environmentId: null,
    stackId: null,
    purpose: 'vault',
    name: 'mini-infra-vault',
    driver: 'bridge',
    options: null,
    status: 'pending',
    enforceMemberships: false,
    ...overrides,
  };
}

function membership(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `member-${Math.random()}`,
    networkId: 'net-1',
    stackServiceId: null,
    containerName: null,
    aliases: null,
    staticIp: null,
    source: 'system',
    createdBy: null,
    ...overrides,
  };
}

function makeDockerExecutor(listContainersImpl: (opts: any) => any[]) {
  const listContainers = vi.fn(async (opts: any) => listContainersImpl(opts));
  return { getDockerClient: () => ({ listContainers }) };
}

function makeNetworkManager(inspectImpl: (name: string) => any) {
  return { inspectForReconcile: vi.fn(async (name: string) => inspectImpl(name)) } as any;
}

describe('listManagedNetworks', () => {
  beforeEach(() => {
    selfContainerId = 'self-container-id';
  });

  it('reports a self membership as connected when Docker shows it attached, with a resolved owner/purpose', async () => {
    const prisma = makeMockPrisma({
      managedNetworks: [net()],
      networkMemberships: [membership({ containerName: 'self', source: 'system' })],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      dockerId: 'docker-id-1',
      subnet: '172.20.0.0/16',
      connectedContainers: [{ id: 'self-container-id', name: 'mini-infra-server' }],
    }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const views = await listManagedNetworks({ prisma, networkManager, dockerExecutor, log } as any);

    expect(views).toHaveLength(1);
    const view = views[0];
    expect(view).toMatchObject({
      name: 'mini-infra-vault',
      scope: 'host',
      existence: 'present',
      dockerId: 'docker-id-1',
      subnet: '172.20.0.0/16',
      driftStatus: 'synced',
      driftItemCount: 0,
    });
    expect(view.memberships).toHaveLength(1);
    expect(view.memberships[0]).toMatchObject({
      containerName: 'self',
      source: 'system',
      status: 'connected',
      // `resolveTargetContainers`'s SELF_SENTINEL resolution reports the
      // container by the literal 'self' name, not the Docker-inspected one
      // (see network-reconciler.ts) — this listing reuses that primitive
      // as-is rather than re-deriving a display name.
      connectedContainers: [{ id: 'self-container-id', name: 'self' }],
    });
    expect(view.unattributedContainers).toEqual([]);
  });

  it('marks a membership "not-deployed" when its target service has no live container yet', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', name: 'my-app', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }], removedAt: null }],
      managedNetworks: [net({ id: 'net-2', scope: 'environment', environmentId: 'env-1', purpose: 'egress', name: 'local-egress' })],
      networkMemberships: [membership({ id: 'm-1', networkId: 'net-2', stackServiceId: 'svc-1', source: 'egress' })],
      environments: [{ id: 'env-1', name: 'local' }],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [],
    }));
    // No live container for stack-1/api — resolveTargetContainers returns [].
    const dockerExecutor = makeDockerExecutor(() => []);

    const views = await listManagedNetworks(
      { prisma, networkManager, dockerExecutor, log } as any,
      { environmentId: 'env-1' },
    );

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ environmentId: 'env-1', environmentName: 'local', purpose: 'egress' });
    expect(views[0].memberships[0]).toMatchObject({
      stackServiceId: 'svc-1',
      serviceName: 'api',
      stackName: 'my-app',
      status: 'not-deployed',
      connectedContainers: [],
    });
  });

  it('filtering by stackId surfaces both the stack-owned network AND a shared network it merely joins (e.g. egress) — not just rows where ManagedNetwork.stackId matches', async () => {
    // Regression coverage for the Phase 9 fix: `ManagedNetwork.stackId` is
    // only ever set for networks a stack OWNS (scope='stack'); a shared
    // network like egress has stackId=null and is only discoverable via a
    // membership row targeting this stack's own service. A naive
    // `where: { stackId }` filter would silently drop it from an
    // application's "connected networks" list.
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', name: 'my-app', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }], removedAt: null }],
      managedNetworks: [
        net({ id: 'net-owned', scope: 'stack', stackId: 'stack-1', purpose: 'appnet', name: 'my-app_appnet' }),
        net({ id: 'net-egress', scope: 'environment', environmentId: 'env-1', purpose: 'egress', name: 'local-egress' }),
      ],
      networkMemberships: [
        membership({ id: 'm-owned', networkId: 'net-owned', stackServiceId: 'svc-1', source: 'template' }),
        membership({ id: 'm-egress', networkId: 'net-egress', stackServiceId: 'svc-1', source: 'egress' }),
      ],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const views = await listManagedNetworks(
      { prisma, networkManager, dockerExecutor, log } as any,
      { stackId: 'stack-1' },
    );

    const names = views.map((v) => v.name).sort();
    expect(names).toEqual(['local-egress', 'my-app_appnet']);
    const egressView = views.find((v) => v.name === 'local-egress');
    expect(egressView?.memberships[0]).toMatchObject({ source: 'egress', stackServiceId: 'svc-1' });
  });

  it('marks a membership "missing" (and the network "drifted") when the live container exists but is not attached', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', name: 'my-app', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }], removedAt: null }],
      managedNetworks: [net({ id: 'net-3', scope: 'stack', stackId: 'stack-1', purpose: 'appnet', name: 'my-app_appnet' })],
      networkMemberships: [membership({ id: 'm-2', networkId: 'net-3', stackServiceId: 'svc-1', source: 'template' })],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [], // nothing attached
    }));
    const dockerExecutor = makeDockerExecutor(() => [
      { Id: 'container-1', Names: ['/api-1'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'api' } },
    ]);

    const views = await listManagedNetworks(
      { prisma, networkManager, dockerExecutor, log } as any,
      { stackId: 'stack-1' },
    );

    expect(views).toHaveLength(1);
    expect(views[0].memberships[0].status).toBe('missing');
    // Drift status is reused from the Phase 7 reconciler (reconcileStack),
    // never re-derived — a real membership-missing item must surface here.
    expect(views[0].driftStatus).toBe('drifted');
    expect(views[0].driftItemCount).toBeGreaterThan(0);
  });

  it('resolves createdBy to a display name for a source:"user" membership', async () => {
    const prisma = makeMockPrisma({
      managedNetworks: [net({ id: 'net-4', scope: 'host', purpose: 'phase6-external-net', name: 'phase6-external-net' })],
      networkMemberships: [membership({ id: 'm-3', networkId: 'net-4', containerName: 'external-db', source: 'user', createdBy: 'user-1' })],
      users: [{ id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' }],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const views = await listManagedNetworks({ prisma, networkManager, dockerExecutor, log } as any);

    expect(views[0].memberships[0]).toMatchObject({
      source: 'user',
      createdBy: 'user-1',
      createdByName: 'Ada Lovelace',
      status: 'not-deployed',
    });
  });

  it('surfaces a live container with no matching membership row as unattributed, not silently dropped', async () => {
    const prisma = makeMockPrisma({
      managedNetworks: [net({ id: 'net-5', purpose: 'dataplane', name: 'mini-infra-dataplane' })],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [{ id: 'mystery-container', name: 'haproxy-1' }],
    }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const views = await listManagedNetworks({ prisma, networkManager, dockerExecutor, log } as any);

    expect(views[0].memberships).toEqual([]);
    expect(views[0].unattributedContainers).toEqual([{ id: 'mystery-container', name: 'haproxy-1' }]);
  });

  it('returns an empty array when no ManagedNetwork rows match the filter', async () => {
    const prisma = makeMockPrisma({});
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const views = await listManagedNetworks({ prisma, networkManager, dockerExecutor, log } as any, { environmentId: 'gone' });
    expect(views).toEqual([]);
  });

  it('returns an empty array for a real stack that owns and joins no networks yet', async () => {
    // Uses `resolveStackScopedNetworks` (shared with `reconcileStack`) under
    // the hood, which — like `reconcileStack` — requires the stack to exist
    // (`findUniqueOrThrow`); a stack id that doesn't exist at all is a
    // caller error, not an empty-result case.
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-empty', name: 'freshly-created', services: [], removedAt: null }],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const views = await listManagedNetworks({ prisma, networkManager, dockerExecutor, log } as any, { stackId: 'stack-empty' });
    expect(views).toEqual([]);
  });
});
