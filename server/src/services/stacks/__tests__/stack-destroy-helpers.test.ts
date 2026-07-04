import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  removeStackNetworksAndVolumes,
  removeStackInfraResources,
  removeStackManagedNetworks,
} from '../stack-destroy-helpers';

// Stub DockerExecutorService so we don't try to hit a real daemon — only
// getDockerClient() matters here, NetworkManager does the rest.
const {
  mockGetNetwork,
  mockListNetworks,
  mockCreateNetwork,
  mockDockerClient,
  mockInitialize,
  mockVolumeExists,
  mockRemoveVolume,
  mockInfraResourceDeleteMany,
  mockManagedNetworkDeleteMany,
  mockNetworkMembershipDeleteMany,
  mockStackServiceFindMany,
} = vi.hoisted(() => {
  const _mockGetNetwork = vi.fn();
  const _mockListNetworks = vi.fn();
  const _mockCreateNetwork = vi.fn();
  return {
    mockGetNetwork: _mockGetNetwork,
    mockListNetworks: _mockListNetworks,
    mockCreateNetwork: _mockCreateNetwork,
    mockDockerClient: {
      getNetwork: _mockGetNetwork,
      listNetworks: _mockListNetworks,
      createNetwork: _mockCreateNetwork,
    },
    mockInitialize: vi.fn().mockResolvedValue(undefined),
    mockVolumeExists: vi.fn().mockResolvedValue(false),
    mockRemoveVolume: vi.fn().mockResolvedValue(undefined),
    mockInfraResourceDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    mockManagedNetworkDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    mockNetworkMembershipDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    mockStackServiceFindMany: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../docker-executor', () => ({
  DockerExecutorService: class {
    initialize = mockInitialize;
    getDockerClient = () => mockDockerClient;
    volumeExists = mockVolumeExists;
    removeVolume = mockRemoveVolume;
  },
}));

// removeStackInfraResources/removeStackManagedNetworks use the
// default-exported prisma singleton directly (matching the rest of this
// file's helpers) — stub just the delegates each one touches.
vi.mock('../../../lib/prisma', () => ({
  default: {
    infraResource: {
      deleteMany: mockInfraResourceDeleteMany,
    },
    managedNetwork: {
      deleteMany: mockManagedNetworkDeleteMany,
    },
    networkMembership: {
      deleteMany: mockNetworkMembershipDeleteMany,
    },
    stackService: {
      findMany: mockStackServiceFindMany,
    },
  },
}));

// Use the real NetworkManager class (behavior under test) but skip the
// DockerService cache-invalidation side channel — that wiring is covered by
// network-manager.test.ts directly via dependency injection.
vi.mock('../../networks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../networks')>();
  return {
    ...actual,
    createNetworkManager: (dockerSource: { getDockerClient: () => unknown }) =>
      new actual.NetworkManager(dockerSource as never),
  };
});

function networkHandle(overrides: Partial<{ inspect: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }> = {}) {
  return {
    inspect: vi.fn().mockResolvedValue({ Containers: {} }),
    remove: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  };
}

describe('removeStackNetworksAndVolumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockVolumeExists.mockResolvedValue(false);
    mockListNetworks.mockResolvedValue([]);
  });

  it('removes networks discovered via the owner label query', async () => {
    const handle = networkHandle();
    mockListNetworks.mockResolvedValue([{ Name: 'mini-infra-webapp_default' }]);
    mockGetNetwork.mockImplementation(() => handle);

    const { networksRemoved } = await removeStackNetworksAndVolumes(
      'stack-1',
      'mini-infra-webapp',
      [{ name: 'default' }],
      [],
    );

    expect(mockListNetworks).toHaveBeenCalledWith({
      filters: { label: ['mini-infra.managed=true', 'mini-infra.owner-kind=stack', 'mini-infra.owner-id=stack-1'] },
    });
    expect(handle.remove).toHaveBeenCalled();
    expect(networksRemoved).toEqual(['mini-infra-webapp_default']);
  });

  it('falls back to the name-derived candidate (correct project name) for a pre-label network the owner query missed — fixes the L1 destroy-orphan bug', async () => {
    const handle = networkHandle();
    // The label query finds nothing (simulating a network created before
    // ownership labels existed), so removal must fall back to the
    // name-derived candidate built from the CORRECT project name
    // (`mini-infra-<stack>` for a host-scoped stack) rather than a
    // mismatched inline re-derivation.
    mockListNetworks.mockResolvedValue([]);
    mockGetNetwork.mockImplementation(() => handle);

    const { networksRemoved } = await removeStackNetworksAndVolumes(
      'stack-1',
      'mini-infra-webapp',
      [{ name: 'default' }],
      [],
    );

    expect(mockGetNetwork).toHaveBeenCalledWith('mini-infra-webapp_default');
    expect(handle.remove).toHaveBeenCalled();
    expect(networksRemoved).toEqual(['mini-infra-webapp_default']);
  });

  it('includes the synthesised default network in the fallback candidates when the caller passes it — fixes the L2 destroy-orphan bug', async () => {
    const explicitHandle = networkHandle();
    const defaultHandle = networkHandle();
    mockListNetworks.mockResolvedValue([]);
    mockGetNetwork.mockImplementation((name: string) =>
      name.endsWith('_default') ? defaultHandle : explicitHandle,
    );

    // Caller is responsible for running synthesiseDefaultNetworkIfNeeded
    // before calling in — here we simulate that result directly: an
    // explicitly-declared network plus the synthesised `default` network.
    const { networksRemoved } = await removeStackNetworksAndVolumes(
      'stack-1',
      'prod-webapp',
      [{ name: 'app_network' }, { name: 'default' }],
      [],
    );

    expect(explicitHandle.remove).toHaveBeenCalled();
    expect(defaultHandle.remove).toHaveBeenCalled();
    expect(networksRemoved).toEqual(
      expect.arrayContaining(['prod-webapp_app_network', 'prod-webapp_default']),
    );
    expect(networksRemoved).toHaveLength(2);
  });

  it('does not fail the whole destroy when one network refuses removal (containers still attached) — logs and continues', async () => {
    const busyHandle = networkHandle({ inspect: vi.fn().mockResolvedValue({ Containers: { c1: {} } }) });
    const cleanHandle = networkHandle();
    mockListNetworks.mockResolvedValue([]);
    mockGetNetwork.mockImplementation((name: string) => (name.includes('busy') ? busyHandle : cleanHandle));

    const { networksRemoved } = await removeStackNetworksAndVolumes(
      'stack-1',
      'prod-webapp',
      [{ name: 'busy' }, { name: 'clean' }],
      [],
    );

    expect(busyHandle.remove).not.toHaveBeenCalled();
    expect(cleanHandle.remove).toHaveBeenCalled();
    expect(networksRemoved).toEqual(['prod-webapp_clean']);
  });

  it('still removes volumes by name (untouched by this phase)', async () => {
    mockListNetworks.mockResolvedValue([]);
    mockGetNetwork.mockImplementation(() => networkHandle({ inspect: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 })) }));
    mockVolumeExists.mockResolvedValue(true);

    const { volumesRemoved } = await removeStackNetworksAndVolumes(
      'stack-1',
      'prod-webapp',
      [],
      [{ name: 'data' }],
    );

    expect(mockRemoveVolume).toHaveBeenCalledWith('prod-webapp_data');
    expect(volumesRemoved).toEqual(['prod-webapp_data']);
  });
});

describe('removeStackInfraResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes every InfraResource row owned by the stack (fixes L4 — stackId is onDelete: SetNull, so nothing else ever removed these rows)', async () => {
    mockInfraResourceDeleteMany.mockResolvedValue({ count: 2 });

    const count = await removeStackInfraResources('stack-1');

    expect(mockInfraResourceDeleteMany).toHaveBeenCalledWith({ where: { stackId: 'stack-1' } });
    expect(count).toBe(2);
  });

  it('returns 0 without error when the stack owns no InfraResource rows', async () => {
    mockInfraResourceDeleteMany.mockResolvedValue({ count: 0 });

    const count = await removeStackInfraResources('stack-with-nothing');

    expect(count).toBe(0);
  });
});

describe('removeStackManagedNetworks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStackServiceFindMany.mockResolvedValue([]);
    mockManagedNetworkDeleteMany.mockResolvedValue({ count: 0 });
    mockNetworkMembershipDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("deletes every ManagedNetwork row this stack owns (scope: 'stack') — fixes the PR #479 review HIGH where an orphaned row got silently reused by name on stack recreate", async () => {
    mockManagedNetworkDeleteMany.mockResolvedValue({ count: 2 });

    const { networksDeleted } = await removeStackManagedNetworks('stack-1');

    expect(mockManagedNetworkDeleteMany).toHaveBeenCalledWith({
      where: { scope: 'stack', stackId: 'stack-1' },
    });
    expect(networksDeleted).toBe(2);
  });

  it("also deletes NetworkMembership rows the stack's own services hold on networks they merely joined (shared env/host networks that don't cascade from the stack's own ManagedNetwork rows)", async () => {
    mockStackServiceFindMany.mockResolvedValue([{ id: 'svc-1' }, { id: 'svc-2' }]);
    mockNetworkMembershipDeleteMany.mockResolvedValue({ count: 3 });

    const { membershipsDeleted } = await removeStackManagedNetworks('stack-1');

    expect(mockStackServiceFindMany).toHaveBeenCalledWith({
      where: { stackId: 'stack-1' },
      select: { id: true },
    });
    expect(mockNetworkMembershipDeleteMany).toHaveBeenCalledWith({
      where: { stackServiceId: { in: ['svc-1', 'svc-2'] } },
    });
    expect(membershipsDeleted).toBe(3);
  });

  it('skips the NetworkMembership cleanup query entirely when the stack has no services (avoids an unnecessary/unsafe empty-`in` query)', async () => {
    mockStackServiceFindMany.mockResolvedValue([]);

    const { membershipsDeleted } = await removeStackManagedNetworks('stack-with-no-services');

    expect(mockNetworkMembershipDeleteMany).not.toHaveBeenCalled();
    expect(membershipsDeleted).toBe(0);
  });

  it('returns zero counts without error when the stack owns nothing', async () => {
    const result = await removeStackManagedNetworks('stack-with-nothing');

    expect(result).toEqual({ networksDeleted: 0, membershipsDeleted: 0 });
  });
});
