import { NetworkManager } from '../network-manager';

/** Minimal shape of a dockerode error carrying a Docker API status code. */
function dockerError(statusCode: number, message = 'docker error'): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

interface MockNetworkHandle {
  inspect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function makeNetworkHandle(overrides: Partial<MockNetworkHandle> = {}): MockNetworkHandle {
  return {
    inspect: vi.fn().mockRejectedValue(dockerError(404, 'network not found')),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A tiny in-memory dockerode stand-in: `handles` maps network name -> mock handle. */
function makeMockDocker(handles: Record<string, MockNetworkHandle> = {}) {
  const getNetwork = vi.fn((name: string) => handles[name] ?? (handles[name] = makeNetworkHandle()));
  const createNetwork = vi.fn().mockResolvedValue({ id: 'new-network-id' });
  const listNetworks = vi.fn().mockResolvedValue([]);
  return { getNetwork, createNetwork, listNetworks, handles };
}

function makeManager(docker: ReturnType<typeof makeMockDocker>, invalidateCache?: () => void) {
  return new NetworkManager({ getDockerClient: () => docker as never }, { invalidateCache });
}

describe('NetworkManager', () => {
  describe('exists', () => {
    it('returns "present" when inspect succeeds', async () => {
      const docker = makeMockDocker({ net1: makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({}) }) });
      const manager = makeManager(docker);
      expect(await manager.exists('net1')).toBe('present');
    });

    it('returns "absent" on a 404', async () => {
      const docker = makeMockDocker({ net1: makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(dockerError(404)) }) });
      const manager = makeManager(docker);
      expect(await manager.exists('net1')).toBe('absent');
    });

    it('returns "unknown" (never "absent") on a non-404 error — a daemon outage must not be treated as missing', async () => {
      const docker = makeMockDocker({
        net1: makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
      });
      const manager = makeManager(docker);
      expect(await manager.exists('net1')).toBe('unknown');
    });

    it('returns "unknown" on a 500', async () => {
      const docker = makeMockDocker({ net1: makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(dockerError(500)) }) });
      const manager = makeManager(docker);
      expect(await manager.exists('net1')).toBe('unknown');
    });
  });

  describe('inspect', () => {
    it('returns Docker-owned facts (ipam, labels, connected containers) when the network exists', async () => {
      const docker = makeMockDocker({
        net1: makeNetworkHandle({
          inspect: vi.fn().mockResolvedValue({
            Name: 'net1',
            Id: 'abc123',
            Driver: 'bridge',
            Labels: { 'mini-infra.managed': 'true' },
            IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] },
            Containers: { c1: {}, c2: {} },
          }),
        }),
      });
      const manager = makeManager(docker);

      const result = await manager.inspect('net1');

      expect(result).toEqual({
        name: 'net1',
        id: 'abc123',
        driver: 'bridge',
        labels: { 'mini-infra.managed': 'true' },
        ipam: { subnet: '172.30.0.0/24', gateway: '172.30.0.1' },
        connectedContainerIds: ['c1', 'c2'],
      });
    });

    it('returns undefined (not an error) when the network does not exist', async () => {
      const docker = makeMockDocker({ net1: makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(dockerError(404)) }) });
      const manager = makeManager(docker);

      expect(await manager.inspect('net1')).toBeUndefined();
    });

    it('rethrows on a non-404 inspect failure (Docker unreachable) rather than treating it as absent', async () => {
      const docker = makeMockDocker({ net1: makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }) });
      const manager = makeManager(docker);

      await expect(manager.inspect('net1')).rejects.toThrow('ECONNREFUSED');
    });

    it('omits ipam when the network has no IPAM config', async () => {
      const docker = makeMockDocker({
        net1: makeNetworkHandle({
          inspect: vi.fn().mockResolvedValue({ Name: 'net1', Containers: {} }),
        }),
      });
      const manager = makeManager(docker);

      const result = await manager.inspect('net1');
      expect(result?.ipam).toBeUndefined();
      expect(result?.connectedContainerIds).toEqual([]);
    });
  });

  describe('ensure', () => {
    it('creates the network with the standard mini-infra.* labels when absent', async () => {
      const docker = makeMockDocker();
      const invalidateCache = vi.fn();
      const manager = makeManager(docker, invalidateCache);

      const result = await manager.ensure({
        name: 'mini-infra-app_default',
        owner: { kind: 'stack', id: 'stack-1' },
        purpose: '_stack',
        driver: 'bridge',
      });

      expect(result).toMatchObject({ name: 'mini-infra-app_default', created: true, existence: 'present' });
      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: 'mini-infra-app_default',
          Driver: 'bridge',
          Labels: {
            'mini-infra.managed': 'true',
            'mini-infra.owner-kind': 'stack',
            'mini-infra.owner-id': 'stack-1',
            'mini-infra.purpose': '_stack',
          },
        }),
      );
      expect(invalidateCache).toHaveBeenCalled();
    });

    it('omits owner-id from labels for a host-scoped owner', async () => {
      const docker = makeMockDocker();
      const manager = makeManager(docker);

      await manager.ensure({ name: 'mini-infra-vault', owner: { kind: 'host' }, purpose: 'vault' });

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Labels: expect.not.objectContaining({ 'mini-infra.owner-id': expect.anything() }),
        }),
      );
    });

    it('passes options through to Docker, coercing values to strings (defect B2)', async () => {
      const docker = makeMockDocker();
      const manager = makeManager(docker);

      await manager.ensure({
        name: 'net1',
        owner: { kind: 'stack', id: 'stack-1' },
        options: { 'com.docker.network.bridge.enable_icc': false as unknown as string, mtu: 1500 as unknown as string },
      });

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Options: { 'com.docker.network.bridge.enable_icc': 'false', mtu: '1500' },
        }),
      );
    });

    it('merges extraLabels alongside the ownership labels', async () => {
      const docker = makeMockDocker();
      const manager = makeManager(docker);

      await manager.ensure({
        name: 'net1',
        owner: { kind: 'stack', id: 'stack-1' },
        extraLabels: { 'mini-infra.stack': 'webapp', 'mini-infra.stack-id': 'stack-1' },
      });

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Labels: expect.objectContaining({
            'mini-infra.managed': 'true',
            'mini-infra.stack': 'webapp',
          }),
        }),
      );
    });

    it('does not create when the network already exists, and reports no mismatch when spec matches', async () => {
      const docker = makeMockDocker({
        net1: makeNetworkHandle({
          inspect: vi.fn().mockResolvedValue({
            Name: 'net1',
            Driver: 'bridge',
            Labels: { 'mini-infra.managed': 'true', 'mini-infra.owner-kind': 'stack', 'mini-infra.owner-id': 'stack-1', 'mini-infra.purpose': '_stack' },
            Options: {},
            Containers: {},
          }),
        }),
      });
      const manager = makeManager(docker);

      const result = await manager.ensure({ name: 'net1', owner: { kind: 'stack', id: 'stack-1' }, purpose: '_stack' });

      expect(result).toEqual({ name: 'net1', created: false, existence: 'present', mismatch: undefined });
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });

    it('flags a mismatch (without recreating) when an existing network\'s driver or labels differ from spec', async () => {
      const docker = makeMockDocker({
        net1: makeNetworkHandle({
          inspect: vi.fn().mockResolvedValue({
            Name: 'net1',
            Driver: 'host',
            Labels: {},
            Options: {},
            Containers: {},
          }),
        }),
      });
      const manager = makeManager(docker);

      const result = await manager.ensure({ name: 'net1', owner: { kind: 'stack', id: 'stack-1' }, driver: 'bridge' });

      expect(result.created).toBe(false);
      expect(result.mismatch?.driver).toEqual({ expected: 'bridge', actual: 'host' });
      expect(result.mismatch?.labels?.missing).toEqual(
        expect.arrayContaining(['mini-infra.managed', 'mini-infra.owner-kind', 'mini-infra.owner-id']),
      );
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });

    it('treats a 409 on create as a race — another apply created it first — and returns success', async () => {
      const docker = makeMockDocker();
      docker.createNetwork.mockRejectedValueOnce(dockerError(409));
      const manager = makeManager(docker);

      const result = await manager.ensure({ name: 'net1', owner: { kind: 'stack', id: 'stack-1' } });

      expect(result).toEqual({ name: 'net1', created: false, existence: 'present' });
    });

    it('rethrows when the inspect fails for a reason other than 404 (Docker unreachable) rather than racing a create', async () => {
      const docker = makeMockDocker({
        net1: makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(new Error('socket hang up')) }),
      });
      const manager = makeManager(docker);

      await expect(manager.ensure({ name: 'net1', owner: { kind: 'stack', id: 'stack-1' } })).rejects.toThrow('socket hang up');
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });
  });

  describe('connect', () => {
    it('connects a container that is not yet attached', async () => {
      const handle = makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
      const docker = makeMockDocker({ net1: handle });
      const invalidateCache = vi.fn();
      const manager = makeManager(docker, invalidateCache);

      const result = await manager.connect('container-1', 'net1', { aliases: ['api'] });

      expect(result).toEqual({ connected: true, alreadyConnected: false });
      expect(handle.connect).toHaveBeenCalledWith({
        Container: 'container-1',
        EndpointConfig: { Aliases: ['api'] },
      });
      expect(invalidateCache).toHaveBeenCalled();
    });

    it('is idempotent by inspection — a container already listed on the network is a no-op, not a connect attempt', async () => {
      const handle = makeNetworkHandle({
        inspect: vi.fn().mockResolvedValue({ Containers: { 'container-1': { Name: 'x' } } }),
      });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      const result = await manager.connect('container-1', 'net1');

      expect(result).toEqual({ connected: true, alreadyConnected: true });
      expect(handle.connect).not.toHaveBeenCalled();
    });

    it('treats a 403/409 from the connect call itself as "already connected" (Docker\'s own idempotency signal, not a message match)', async () => {
      const handle = makeNetworkHandle({
        inspect: vi.fn().mockResolvedValue({ Containers: {} }),
        connect: vi.fn().mockRejectedValue(dockerError(403, 'endpoint already exists in network')),
      });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      const result = await manager.connect('container-1', 'net1');

      expect(result).toEqual({ connected: true, alreadyConnected: true });
    });

    it('rethrows a genuine connect failure (not 403/409)', async () => {
      const handle = makeNetworkHandle({
        inspect: vi.fn().mockResolvedValue({ Containers: {} }),
        connect: vi.fn().mockRejectedValue(dockerError(500, 'internal error')),
      });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      await expect(manager.connect('container-1', 'net1')).rejects.toThrow('internal error');
    });

    it('rethrows when the network itself does not exist (404 on inspect)', async () => {
      const handle = makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(dockerError(404)) });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      await expect(manager.connect('container-1', 'net1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('disconnect', () => {
    it('disconnects and invalidates the cache', async () => {
      const handle = makeNetworkHandle();
      const docker = makeMockDocker({ net1: handle });
      const invalidateCache = vi.fn();
      const manager = makeManager(docker, invalidateCache);

      await manager.disconnect('container-1', 'net1', { force: true });

      expect(handle.disconnect).toHaveBeenCalledWith({ Container: 'container-1', Force: true });
      expect(invalidateCache).toHaveBeenCalled();
    });

    it('treats a 404 as an idempotent no-op', async () => {
      const handle = makeNetworkHandle({ disconnect: vi.fn().mockRejectedValue(dockerError(404)) });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      await expect(manager.disconnect('container-1', 'net1')).resolves.toBeUndefined();
    });
  });

  describe('remove', () => {
    it('refuses to remove a network with attached containers by default', async () => {
      const handle = makeNetworkHandle({
        inspect: vi.fn().mockResolvedValue({ Containers: { c1: {} } }),
      });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      const result = await manager.remove('net1');

      expect(result).toEqual({ name: 'net1', removed: false, reason: 'has-containers' });
      expect(handle.remove).not.toHaveBeenCalled();
    });

    it('force-disconnects attached containers then removes when forceDisconnect is set', async () => {
      const handle = makeNetworkHandle({
        inspect: vi.fn().mockResolvedValue({ Containers: { c1: {}, c2: {} } }),
      });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      const result = await manager.remove('net1', { forceDisconnect: true });

      expect(handle.disconnect).toHaveBeenCalledTimes(2);
      expect(handle.disconnect).toHaveBeenCalledWith({ Container: 'c1', Force: true });
      expect(handle.disconnect).toHaveBeenCalledWith({ Container: 'c2', Force: true });
      expect(handle.remove).toHaveBeenCalled();
      expect(result).toEqual({ name: 'net1', removed: true });
    });

    it('removes a network with no attached containers and invalidates the cache', async () => {
      const handle = makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
      const docker = makeMockDocker({ net1: handle });
      const invalidateCache = vi.fn();
      const manager = makeManager(docker, invalidateCache);

      const result = await manager.remove('net1');

      expect(result).toEqual({ name: 'net1', removed: true });
      expect(invalidateCache).toHaveBeenCalled();
    });

    it('returns not-found (not an error) when the network is already gone', async () => {
      const handle = makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(dockerError(404)) });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      const result = await manager.remove('net1');

      expect(result).toEqual({ name: 'net1', removed: false, reason: 'not-found' });
    });

    it('does not throw on an unexpected error — returns reason "error" so batch callers can continue', async () => {
      const handle = makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(new Error('boom')) });
      const docker = makeMockDocker({ net1: handle });
      const manager = makeManager(docker);

      const result = await manager.remove('net1');

      expect(result).toEqual({ name: 'net1', removed: false, reason: 'error' });
    });
  });

  describe('removeByOwner', () => {
    it('queries Docker by owner-kind + owner-id labels and removes every match', async () => {
      const netA = makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
      const netB = makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
      const docker = makeMockDocker({ 'proj_a': netA, 'proj_b': netB });
      docker.listNetworks.mockResolvedValue([{ Name: 'proj_a' }, { Name: 'proj_b' }]);
      const manager = makeManager(docker);

      const results = await manager.removeByOwner({ kind: 'stack', id: 'stack-1' });

      expect(docker.listNetworks).toHaveBeenCalledWith({
        filters: { label: ['mini-infra.managed=true', 'mini-infra.owner-kind=stack', 'mini-infra.owner-id=stack-1'] },
      });
      expect(netA.remove).toHaveBeenCalled();
      expect(netB.remove).toHaveBeenCalled();
      expect(results.filter((r) => r.removed)).toHaveLength(2);
    });

    it('falls back to name candidates for networks the label query missed (pre-label networks), skipping ones already handled', async () => {
      const labelled = makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
      const unlabelled = makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
      const docker = makeMockDocker({ 'proj_labelled': labelled, 'proj_legacy': unlabelled });
      docker.listNetworks.mockResolvedValue([{ Name: 'proj_labelled' }]);
      const manager = makeManager(docker);

      const results = await manager.removeByOwner(
        { kind: 'stack', id: 'stack-1' },
        { nameFallbackCandidates: ['proj_labelled', 'proj_legacy'] },
      );

      // proj_labelled already handled via the label query — not removed twice.
      expect(labelled.remove).toHaveBeenCalledTimes(1);
      expect(unlabelled.remove).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
    });

    it('skips a fallback candidate that does not exist, and one whose existence is unknown (Docker outage)', async () => {
      const absent = makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(dockerError(404)) });
      const unknown = makeNetworkHandle({ inspect: vi.fn().mockRejectedValue(new Error('ECONNRESET')) });
      const docker = makeMockDocker({ absent, unknown });
      docker.listNetworks.mockResolvedValue([]);
      const manager = makeManager(docker);

      const results = await manager.removeByOwner(
        { kind: 'stack', id: 'stack-1' },
        { nameFallbackCandidates: ['absent', 'unknown'] },
      );

      expect(absent.remove).not.toHaveBeenCalled();
      expect(unknown.remove).not.toHaveBeenCalled();
      expect(results).toHaveLength(0);
    });

    it('falls back to name candidates only (without throwing) when the label query itself fails', async () => {
      const handle = makeNetworkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
      const docker = makeMockDocker({ proj_default: handle });
      docker.listNetworks.mockRejectedValue(new Error('Docker unreachable'));
      const manager = makeManager(docker);

      const results = await manager.removeByOwner(
        { kind: 'stack', id: 'stack-1' },
        { nameFallbackCandidates: ['proj_default'] },
      );

      expect(handle.remove).toHaveBeenCalled();
      expect(results).toEqual([{ name: 'proj_default', removed: true }]);
    });
  });
});
