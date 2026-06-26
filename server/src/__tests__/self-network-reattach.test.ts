import {
  reattachSelfToManagedNetworks,
  connectSelfToNetwork,
} from '../services/stacks/self-network-reattach';

vi.mock('../services/self-update', () => ({
  getOwnContainerId: vi.fn(() => 'self-id'),
}));

function makeExecutor(connectImpl?: () => Promise<void>) {
  const connect = vi.fn(connectImpl ?? (() => Promise.resolve()));
  const getNetwork = vi.fn(() => ({ connect }));
  const executor = { getDockerClient: () => ({ getNetwork }) } as any;
  return { executor, getNetwork, connect };
}

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

describe('reattachSelfToManagedNetworks', () => {
  it('re-attaches only to docker-network resources whose stack declares joinSelf', async () => {
    const { executor, getNetwork, connect } = makeExecutor();
    const prisma = {
      infraResource: {
        findMany: vi.fn().mockResolvedValue([
          {
            name: 'mini-infra-vault',
            purpose: 'vault',
            stack: { resourceOutputs: [{ type: 'docker-network', purpose: 'vault', joinSelf: true }] },
          },
          {
            name: 'mini-infra-database',
            purpose: 'database',
            stack: { resourceOutputs: [{ type: 'docker-network', purpose: 'database', joinSelf: false }] },
          },
          { name: 'orphan-egress', purpose: 'egress', stack: null },
        ]),
      },
    } as any;

    await reattachSelfToManagedNetworks(executor, prisma, log);

    expect(getNetwork).toHaveBeenCalledTimes(1);
    expect(getNetwork).toHaveBeenCalledWith('mini-infra-vault');
    expect(connect).toHaveBeenCalledWith({ Container: 'self-id' });
  });

  it('skips entirely when not running in Docker', async () => {
    const { getOwnContainerId } = await import('../services/self-update');
    (getOwnContainerId as any).mockReturnValueOnce(null);
    const { executor, getNetwork } = makeExecutor();
    const prisma = { infraResource: { findMany: vi.fn() } } as any;

    await reattachSelfToManagedNetworks(executor, prisma, log);

    expect(prisma.infraResource.findMany).not.toHaveBeenCalled();
    expect(getNetwork).not.toHaveBeenCalled();
  });
});

describe('connectSelfToNetwork', () => {
  it('returns true on a fresh attach', async () => {
    const { executor } = makeExecutor();
    expect(await connectSelfToNetwork(executor, 'self-id', 'net', log)).toBe(true);
  });

  it('treats an already-connected 403 as a no-op (false) without throwing', async () => {
    const { executor } = makeExecutor(() =>
      Promise.reject(Object.assign(new Error('endpoint already exists'), { statusCode: 403 })),
    );
    expect(await connectSelfToNetwork(executor, 'self-id', 'net', log)).toBe(false);
  });

  it('warns and returns false on a genuine failure', async () => {
    const warn = vi.fn();
    const localLog = { info: vi.fn(), warn, debug: vi.fn() } as any;
    const { executor } = makeExecutor(() => Promise.reject(new Error('boom')));
    expect(await connectSelfToNetwork(executor, 'self-id', 'net', localLog)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
