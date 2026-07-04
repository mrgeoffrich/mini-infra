import { connectSelfToNetwork } from '../self-network-connect';

function makeExecutor(connectImpl?: () => Promise<void>) {
  const connect = vi.fn(connectImpl ?? (() => Promise.resolve()));
  const getNetwork = vi.fn(() => ({ connect }));
  const executor = { getDockerClient: () => ({ getNetwork }) } as any;
  return { executor, getNetwork, connect };
}

/** Minimal `managedNetwork`/`networkMembership` mock so `connectSelfToNetwork`'s
 * Phase 6 membership-row write is a harmless no-op-then-create in tests that
 * don't care about it. */
function makeMembershipPrisma() {
  return {
    managedNetwork: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'managed-net-1' }),
    },
    networkMembership: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

describe('connectSelfToNetwork', () => {
  it('returns true on a fresh attach', async () => {
    const { executor } = makeExecutor();
    const prisma = makeMembershipPrisma() as any;
    expect(await connectSelfToNetwork(executor, prisma, 'self-id', 'net', log)).toBe(true);
    // Records a source:'system', containerName:'self' membership row.
    expect(prisma.networkMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ containerName: 'self', source: 'system' }),
      }),
    );
  });

  it('treats an already-connected 403 as a no-op (false) without throwing', async () => {
    const { executor } = makeExecutor(() =>
      Promise.reject(Object.assign(new Error('endpoint already exists'), { statusCode: 403 })),
    );
    const prisma = makeMembershipPrisma() as any;
    expect(await connectSelfToNetwork(executor, prisma, 'self-id', 'net', log)).toBe(false);
    // Still records the membership row — already-attached is still "attached".
    expect(prisma.networkMembership.create).toHaveBeenCalled();
  });

  it('warns and returns false on a genuine failure', async () => {
    const warn = vi.fn();
    const localLog = { info: vi.fn(), warn, debug: vi.fn() } as any;
    const { executor } = makeExecutor(() => Promise.reject(new Error('boom')));
    const prisma = makeMembershipPrisma() as any;
    expect(await connectSelfToNetwork(executor, prisma, 'self-id', 'net', localLog)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('defaults the ManagedNetwork fallback identity to host scope when no fallbackIdentity is passed', async () => {
    const { executor } = makeExecutor();
    const prisma = makeMembershipPrisma() as any;
    await connectSelfToNetwork(executor, prisma, 'self-id', 'net', log);
    expect(prisma.managedNetwork.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'host', environmentId: null, stackId: null, purpose: 'net' }),
      }),
    );
  });

  it('uses the caller-supplied fallbackIdentity instead of guessing host scope (network overhaul Phase 9 fix)', async () => {
    const { executor } = makeExecutor();
    const prisma = makeMembershipPrisma() as any;
    await connectSelfToNetwork(executor, prisma, 'self-id', 'local-egress', log, {
      scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'egress',
    });
    expect(prisma.managedNetwork.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'egress' }),
      }),
    );
  });
});
