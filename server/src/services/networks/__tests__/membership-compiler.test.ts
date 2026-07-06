import { compileStackNetworkMemberships, buildMembershipServiceInputs } from '../membership-compiler';

function makeMockPrisma() {
  const managedNetworks = new Map<string, { id: string; scope: string; environmentId: string | null; stackId: string | null; purpose: string; name: string }>();
  const memberships: Array<{ id: string; networkId: string; stackServiceId: string | null; containerName: string | null; source: string; createdBy: string | null; aliases: unknown }> = [];
  let netCounter = 0;
  let memberCounter = 0;

  return {
    managedNetwork: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const row of managedNetworks.values()) {
          if (
            row.scope === where.scope &&
            row.environmentId === where.environmentId &&
            row.stackId === where.stackId &&
            row.purpose === where.purpose
          ) {
            return { id: row.id };
          }
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        for (const row of managedNetworks.values()) {
          if (row.name === where.name) return { id: row.id };
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `net-${++netCounter}`;
        managedNetworks.set(id, { id, ...data });
        return { id };
      }),
    },
    networkMembership: {
      findFirst: vi.fn(async ({ where }: any) => {
        const found = memberships.find(
          (m) => m.networkId === where.networkId && m.stackServiceId === where.stackServiceId && m.containerName === where.containerName,
        );
        return found ? { id: found.id } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `member-${++memberCounter}`;
        memberships.push({ id, stackServiceId: null, containerName: null, createdBy: null, aliases: null, ...data });
        return { id };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = memberships.find((m) => m.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    __state: { managedNetworks, memberships },
  } as any;
}

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

describe('compileStackNetworkMemberships', () => {
  it('compiles stack-owned networks with a service-name alias for every non-host-mode service', async () => {
    const prisma = makeMockPrisma();
    await compileStackNetworkMemberships({
      prisma,
      stack: { id: 'stack-1', environmentId: 'env-1' },
      projectName: 'env-1-app',
      networks: [{ name: 'default' }],
      outputNetworkMap: new Map(),
      inputNetworkMap: new Map(),
      services: [
        { id: 'svc-1', serviceName: 'api', serviceType: 'Stateful', containerConfig: {} },
      ],
      log,
    });

    const [net] = [...prisma.__state.managedNetworks.values()];
    expect(net).toMatchObject({ scope: 'stack', environmentId: 'env-1', stackId: 'stack-1', purpose: 'default', name: 'env-1-app_default' });

    const [member] = prisma.__state.memberships;
    expect(member).toMatchObject({ networkId: net.id, stackServiceId: 'svc-1', source: 'template', aliases: ['api'] });
  });

  it('skips stack-owned network membership for a service with networkMode: host', async () => {
    const prisma = makeMockPrisma();
    await compileStackNetworkMemberships({
      prisma,
      stack: { id: 'stack-1', environmentId: null },
      projectName: 'mini-infra-app',
      networks: [{ name: 'default' }],
      outputNetworkMap: new Map(),
      inputNetworkMap: new Map(),
      services: [
        { id: 'svc-1', serviceName: 'host-svc', serviceType: 'Stateful', containerConfig: { networkMode: 'host' } },
      ],
      log,
    });

    // The ManagedNetwork row is still created (the network itself exists),
    // just no membership row for the host-mode service.
    expect(prisma.__state.managedNetworks.size).toBe(1);
    expect(prisma.__state.memberships).toHaveLength(0);
  });

  it('attributes joinNetworks entries to source: user with createdBy when the stack is a user-authored Application', async () => {
    const prisma = makeMockPrisma();
    await compileStackNetworkMemberships({
      prisma,
      stack: { id: 'stack-1', environmentId: 'env-1', templateSource: 'user', templateCreatedById: 'user-42' },
      projectName: 'env-1-app',
      networks: [],
      outputNetworkMap: new Map(),
      inputNetworkMap: new Map(),
      services: [
        {
          id: 'svc-1', serviceName: 'api', serviceType: 'Stateful',
          containerConfig: { joinNetworks: ['some-db-net'] },
        },
      ],
      log,
    });

    const member = prisma.__state.memberships.find((m: any) => m.stackServiceId === 'svc-1');
    expect(member).toMatchObject({ source: 'user', createdBy: 'user-42' });
  });

  it('keeps joinNetworks entries source: template (no createdBy) for system-authored stacks', async () => {
    const prisma = makeMockPrisma();
    await compileStackNetworkMemberships({
      prisma,
      stack: { id: 'stack-1', environmentId: null, templateSource: 'system' },
      projectName: 'mini-infra-app',
      networks: [],
      outputNetworkMap: new Map(),
      inputNetworkMap: new Map(),
      services: [
        {
          id: 'svc-1', serviceName: 'api', serviceType: 'Stateful',
          containerConfig: { joinNetworks: ['shared-net'] },
        },
      ],
      log,
    });

    const member = prisma.__state.memberships.find((m: any) => m.stackServiceId === 'svc-1');
    expect(member).toMatchObject({ source: 'template', createdBy: null });
  });

  it('resolves joinResourceNetworks against the merged infra network maps and aliases only egressBypass services', async () => {
    const prisma = makeMockPrisma();
    await compileStackNetworkMemberships({
      prisma,
      stack: { id: 'stack-1', environmentId: 'env-1' },
      projectName: 'env-1-app',
      networks: [],
      outputNetworkMap: new Map([['egress', 'env-1-egress']]),
      inputNetworkMap: new Map(),
      services: [
        {
          id: 'svc-1', serviceName: 'egress-gateway', serviceType: 'Stateful',
          containerConfig: { joinResourceNetworks: ['egress'], egressBypass: true },
        },
        {
          id: 'svc-2', serviceName: 'app', serviceType: 'Stateful',
          containerConfig: { joinResourceNetworks: ['egress'] },
        },
      ],
      log,
    });

    const gatewayMember = prisma.__state.memberships.find((m: any) => m.stackServiceId === 'svc-1');
    expect(gatewayMember).toMatchObject({ source: 'template', aliases: ['egress-gateway'] });

    const appMember = prisma.__state.memberships.find((m: any) => m.stackServiceId === 'svc-2');
    expect(appMember).toMatchObject({ source: 'template' });
    expect(appMember.aliases).toBeUndefined();
  });

  it('targets AdoptedWeb services by containerName instead of stackServiceId', async () => {
    const prisma = makeMockPrisma();
    await compileStackNetworkMemberships({
      prisma,
      stack: { id: 'stack-1', environmentId: 'env-1' },
      projectName: 'env-1-app',
      networks: [{ name: 'default' }],
      outputNetworkMap: new Map(),
      inputNetworkMap: new Map(),
      services: [
        {
          id: 'svc-1', serviceName: 'legacy', serviceType: 'AdoptedWeb',
          containerConfig: {},
          adoptedContainer: { containerName: 'legacy-container', listeningPort: 8080 },
        },
      ],
      log,
    });

    const member = prisma.__state.memberships[0];
    expect(member.stackServiceId).toBeNull();
    expect(member.containerName).toBe('legacy-container');
  });

  it('never throws even if the prisma calls fail (write-only bookkeeping is best-effort)', async () => {
    const prisma = makeMockPrisma();
    prisma.managedNetwork.findFirst.mockRejectedValue(new Error('db down'));

    await expect(
      compileStackNetworkMemberships({
        prisma,
        stack: { id: 'stack-1', environmentId: null },
        projectName: 'mini-infra-app',
        networks: [{ name: 'default' }],
        outputNetworkMap: new Map(),
        inputNetworkMap: new Map(),
        services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful', containerConfig: {} }],
        log,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('buildMembershipServiceInputs', () => {
  it('merges real StackService ids with resolved definitions, skipping services with no resolved definition', () => {
    const resolvedDefinitions = new Map([
      ['api', { containerConfig: { joinNetworks: ['x'] }, adoptedContainer: null }],
    ]);

    const result = buildMembershipServiceInputs(
      [
        { id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' },
        { id: 'svc-2', serviceName: 'missing-def', serviceType: 'Stateful' },
      ],
      resolvedDefinitions as any,
    );

    expect(result).toEqual([
      {
        id: 'svc-1', serviceName: 'api', serviceType: 'Stateful',
        containerConfig: { joinNetworks: ['x'] }, adoptedContainer: null,
      },
    ]);
  });
});
