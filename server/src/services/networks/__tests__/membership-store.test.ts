import {
  upsertManagedNetworkByIdentity,
  findOrCreateManagedNetworkByName,
  upsertNetworkMembership,
  resolveMembershipTarget,
  safeMembershipWrite,
} from '../membership-store';

function makeMockPrisma() {
  return {
    managedNetwork: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    networkMembership: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as any;
}

describe('upsertManagedNetworkByIdentity', () => {
  it('creates a new row when no identity or name match exists', async () => {
    const prisma = makeMockPrisma();
    prisma.managedNetwork.findFirst.mockResolvedValue(null);
    prisma.managedNetwork.findUnique.mockResolvedValue(null);
    prisma.managedNetwork.create.mockResolvedValue({ id: 'net-1' });

    const row = await upsertManagedNetworkByIdentity(
      prisma,
      { scope: 'stack', environmentId: 'env-1', stackId: 'stack-1', purpose: 'default' },
      'env-1_stack-1_default',
    );

    expect(row).toEqual({ id: 'net-1' });
    expect(prisma.managedNetwork.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: 'stack', environmentId: 'env-1', stackId: 'stack-1', purpose: 'default',
          name: 'env-1_stack-1_default',
        }),
      }),
    );
  });

  it('returns the existing row by identity without creating a duplicate', async () => {
    const prisma = makeMockPrisma();
    prisma.managedNetwork.findFirst.mockResolvedValue({ id: 'net-existing' });

    const row = await upsertManagedNetworkByIdentity(
      prisma,
      { scope: 'stack', environmentId: 'env-1', stackId: 'stack-1', purpose: 'default' },
      'env-1_stack-1_default',
    );

    expect(row).toEqual({ id: 'net-existing' });
    expect(prisma.managedNetwork.create).not.toHaveBeenCalled();
  });

  it('falls back to a by-name match when the identity guess differs from an already-created row', async () => {
    // Simulates a consumer's best-effort identity guess racing ahead of the
    // true owner's compile — the row already exists under `name`, just not
    // under the identity this caller is trying.
    const prisma = makeMockPrisma();
    prisma.managedNetwork.findFirst.mockResolvedValue(null);
    prisma.managedNetwork.findUnique.mockResolvedValue({ id: 'net-by-name' });

    const row = await upsertManagedNetworkByIdentity(
      prisma,
      { scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'vault' },
      'mini-infra-vault',
    );

    expect(row).toEqual({ id: 'net-by-name' });
    expect(prisma.managedNetwork.create).not.toHaveBeenCalled();
  });

  it('treats environmentId/stackId omission as null (host-scope identity)', async () => {
    const prisma = makeMockPrisma();
    prisma.managedNetwork.findFirst.mockResolvedValue(null);
    prisma.managedNetwork.findUnique.mockResolvedValue(null);
    prisma.managedNetwork.create.mockResolvedValue({ id: 'net-host' });

    await upsertManagedNetworkByIdentity(prisma, { scope: 'host', purpose: 'nats' }, 'mini-infra-nats');

    expect(prisma.managedNetwork.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: 'host', environmentId: null, stackId: null, purpose: 'nats' },
      }),
    );
  });
});

describe('findOrCreateManagedNetworkByName', () => {
  it('returns the existing row by name without creating a duplicate', async () => {
    const prisma = makeMockPrisma();
    prisma.managedNetwork.findUnique.mockResolvedValue({ id: 'net-existing' });

    const row = await findOrCreateManagedNetworkByName(prisma, 'some-net', {
      scope: 'host', purpose: 'some-net',
    });

    expect(row).toEqual({ id: 'net-existing' });
    expect(prisma.managedNetwork.create).not.toHaveBeenCalled();
  });

  it('creates a placeholder row using the fallback identity when no row exists yet', async () => {
    const prisma = makeMockPrisma();
    prisma.managedNetwork.findUnique.mockResolvedValue(null);
    prisma.managedNetwork.create.mockResolvedValue({ id: 'net-new' });

    const row = await findOrCreateManagedNetworkByName(prisma, 'external-net', {
      scope: 'host', environmentId: null, stackId: null, purpose: 'external-net',
    });

    expect(row).toEqual({ id: 'net-new' });
    expect(prisma.managedNetwork.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'host', purpose: 'external-net', name: 'external-net' }),
      }),
    );
  });
});

describe('upsertNetworkMembership', () => {
  it('rejects a target with neither stackServiceId nor containerName', async () => {
    const prisma = makeMockPrisma();
    await expect(
      upsertNetworkMembership(prisma, { networkId: 'net-1', source: 'template' }),
    ).rejects.toThrow(/exactly one/);
  });

  it('rejects a target with both stackServiceId and containerName', async () => {
    const prisma = makeMockPrisma();
    await expect(
      upsertNetworkMembership(prisma, {
        networkId: 'net-1', stackServiceId: 'svc-1', containerName: 'self', source: 'template',
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it('creates a new row when none exists', async () => {
    const prisma = makeMockPrisma();
    prisma.networkMembership.findFirst.mockResolvedValue(null);

    const result = await upsertNetworkMembership(prisma, {
      networkId: 'net-1', stackServiceId: 'svc-1', source: 'template', aliases: ['api'],
    });

    expect(result).toEqual({ created: true });
    expect(prisma.networkMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          networkId: 'net-1', stackServiceId: 'svc-1', containerName: null,
          source: 'template', aliases: ['api'],
        }),
      }),
    );
  });

  it('does not create a duplicate when a matching row already exists (idempotent)', async () => {
    const prisma = makeMockPrisma();
    prisma.networkMembership.findFirst.mockResolvedValue({ id: 'membership-1' });

    const result = await upsertNetworkMembership(prisma, {
      networkId: 'net-1', stackServiceId: 'svc-1', source: 'template',
    });

    expect(result).toEqual({ created: false });
    expect(prisma.networkMembership.create).not.toHaveBeenCalled();
  });

  it('never overwrites source/createdBy on an existing row — provenance is set once', async () => {
    const prisma = makeMockPrisma();
    prisma.networkMembership.findFirst.mockResolvedValue({ id: 'membership-1' });

    // A later 'template' compile of the same (network, service) pair must
    // not relabel a row a producer already recorded as 'user'.
    await upsertNetworkMembership(prisma, {
      networkId: 'net-1', stackServiceId: 'svc-1', source: 'template', createdBy: 'someone-else',
    });

    expect(prisma.networkMembership.update).not.toHaveBeenCalled();
    expect(prisma.networkMembership.create).not.toHaveBeenCalled();
  });

  it('refreshes aliases/staticIp on an existing row even though source is preserved', async () => {
    const prisma = makeMockPrisma();
    prisma.networkMembership.findFirst.mockResolvedValue({ id: 'membership-1' });

    await upsertNetworkMembership(prisma, {
      networkId: 'net-1', containerName: 'egress-gateway-container', source: 'egress',
      staticIp: '10.44.0.5', aliases: ['egress-gateway'],
    });

    expect(prisma.networkMembership.update).toHaveBeenCalledWith({
      where: { id: 'membership-1' },
      data: { aliases: ['egress-gateway'], staticIp: '10.44.0.5' },
    });
  });
});

describe('resolveMembershipTarget', () => {
  it('resolves to stackServiceId for a managed service type', () => {
    expect(resolveMembershipTarget({ id: 'svc-1', serviceType: 'Stateful' })).toEqual({
      stackServiceId: 'svc-1',
    });
  });

  it('resolves to containerName for AdoptedWeb', () => {
    expect(
      resolveMembershipTarget({
        id: 'svc-1', serviceType: 'AdoptedWeb',
        adoptedContainer: { containerName: 'legacy-app', listeningPort: 8080 },
      }),
    ).toEqual({ containerName: 'legacy-app' });
  });

  it('falls back to stackServiceId for AdoptedWeb without an adoptedContainer', () => {
    expect(resolveMembershipTarget({ id: 'svc-1', serviceType: 'AdoptedWeb' })).toEqual({
      stackServiceId: 'svc-1',
    });
  });
});

describe('safeMembershipWrite', () => {
  it('runs the callback and returns normally on success', async () => {
    const log = { warn: vi.fn() } as any;
    const fn = vi.fn().mockResolvedValue(undefined);
    await safeMembershipWrite(log, {}, fn);
    expect(fn).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('swallows a failure and logs a warning instead of throwing', async () => {
    const log = { warn: vi.fn() } as any;
    const fn = vi.fn().mockRejectedValue(new Error('db blip'));
    await expect(safeMembershipWrite(log, { stackId: 'stack-1' }, fn)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stackId: 'stack-1', error: 'db blip' }),
      expect.any(String),
    );
  });
});
