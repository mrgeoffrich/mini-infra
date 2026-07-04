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

describe('orphaned-row hijack regression (PR #479 review HIGH)', () => {
  /**
   * A minimal in-memory stand-in for the `managedNetwork` delegate that
   * actually behaves like Prisma (rows really disappear on delete, `create`
   * really persists a fresh row) — unlike `makeMockPrisma()` above, which
   * only returns canned responses. Needed here because the whole point of
   * this test is to prove state genuinely changes across a delete +
   * recreate, not just that the right calls were made.
   */
  function makeStatefulManagedNetworkPrisma() {
    const rows: Array<{
      id: string; scope: string; environmentId: string | null; stackId: string | null;
      purpose: string; name: string;
    }> = [];
    let nextId = 1;
    return {
      managedNetwork: {
        findFirst: vi.fn(async ({ where }: { where: { scope: string; environmentId: string | null; stackId: string | null; purpose: string } }) =>
          rows.find(
            (r) => r.scope === where.scope && r.environmentId === where.environmentId
              && r.stackId === where.stackId && r.purpose === where.purpose,
          ) ?? null),
        findUnique: vi.fn(async ({ where }: { where: { name: string } }) =>
          rows.find((r) => r.name === where.name) ?? null),
        create: vi.fn(async ({ data }: { data: { scope: string; environmentId?: string | null; stackId?: string | null; purpose: string; name: string } }) => {
          const row = {
            id: `net-${nextId++}`,
            scope: data.scope,
            environmentId: data.environmentId ?? null,
            stackId: data.stackId ?? null,
            purpose: data.purpose,
            name: data.name,
          };
          rows.push(row);
          return row;
        }),
        deleteMany: vi.fn(async ({ where }: { where: { scope: string; stackId: string } }) => {
          const before = rows.length;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].scope === where.scope && rows[i].stackId === where.stackId) rows.splice(i, 1);
          }
          return { count: before - rows.length };
        }),
      },
      _rows: rows,
    } as any;
  }

  it('creates a FRESH row carrying the NEW stackId — never reuses the dead stack\'s row — once the orphaned row has actually been deleted', async () => {
    const prisma = makeStatefulManagedNetworkPrisma();
    const networkName = 'prod-webapp_default';

    // The dead stack's row, exactly as it would have looked before destroy.
    await upsertManagedNetworkByIdentity(
      prisma,
      { scope: 'stack', environmentId: 'env-1', stackId: 'stack-OLD', purpose: 'default' },
      networkName,
    );
    expect(prisma._rows).toHaveLength(1);
    expect(prisma._rows[0].stackId).toBe('stack-OLD');

    // Simulates the destroy-route fix: `removeStackManagedNetworks` deletes
    // every `scope: 'stack'` row owned by the dead stack before the stack
    // row itself is hard-deleted.
    await prisma.managedNetwork.deleteMany({ where: { scope: 'stack', stackId: 'stack-OLD' } });
    expect(prisma._rows).toHaveLength(0);

    // A brand-new stack, in the same environment, happens to derive the
    // exact same network name (same env + same declared network purpose).
    const row = await upsertManagedNetworkByIdentity(
      prisma,
      { scope: 'stack', environmentId: 'env-1', stackId: 'stack-NEW', purpose: 'default' },
      networkName,
    );

    expect(prisma._rows).toHaveLength(1);
    expect(prisma._rows[0].id).toBe(row.id);
    expect(prisma._rows[0].stackId).toBe('stack-NEW'); // fresh row, NEW stackId — no hijack.
    expect(prisma._rows[0].stackId).not.toBe('stack-OLD');
  });

  it('would have hijacked the row (reused the dead stackId) if the orphaned row were never deleted — demonstrates the defect the fix closes', async () => {
    const prisma = makeStatefulManagedNetworkPrisma();
    const networkName = 'prod-webapp_default';

    await upsertManagedNetworkByIdentity(
      prisma,
      { scope: 'stack', environmentId: 'env-1', stackId: 'stack-OLD', purpose: 'default' },
      networkName,
    );

    // No deleteMany call here — simulates the pre-fix behavior where destroy
    // never removed the ManagedNetwork row.
    const row = await upsertManagedNetworkByIdentity(
      prisma,
      { scope: 'stack', environmentId: 'env-1', stackId: 'stack-NEW', purpose: 'default' },
      networkName,
    );

    // Identity lookup misses (different stackId), but the by-name fallback
    // hits the orphaned row and hands it back — still stamped stackId: 'stack-OLD'.
    expect(prisma._rows).toHaveLength(1);
    expect(row.id).toBe(prisma._rows[0].id);
    expect(prisma._rows[0].stackId).toBe('stack-OLD');
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
