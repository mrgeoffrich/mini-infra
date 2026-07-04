import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StackServiceDefinition } from '@mini-infra/types';
import { attachServiceNetworks, type AttachServiceNetworksContext } from '../attach-service-networks';

// `attachEgressNetworkIfNeeded` talks to Prisma internally; mock it so these
// tests stay focused on the joinNetworks/joinResourceNetworks extension
// points (`extraJoinNetworks` / `extraResourcePurposes`) added in the pools
// overhaul phase, and assert separately that it's still invoked with the
// right args on every call.
const mockAttachEgressNetworkIfNeeded = vi.fn().mockResolvedValue(undefined);
vi.mock('../../stacks/egress-injection', () => ({
  attachEgressNetworkIfNeeded: (...args: unknown[]) => mockAttachEgressNetworkIfNeeded(...args),
}));

function makeServiceDef(
  overrides: Partial<StackServiceDefinition['containerConfig']> = {},
): StackServiceDefinition {
  return {
    serviceName: 'worker',
    serviceType: 'Stateful',
    dockerImage: 'img',
    dockerTag: 'latest',
    dependsOn: [],
    order: 1,
    containerConfig: {
      env: {},
      ...overrides,
    },
  };
}

describe('attachServiceNetworks', () => {
  let networkManager: { connect: ReturnType<typeof vi.fn> };
  let infraManager: { joinResourceNetworks: ReturnType<typeof vi.fn> };
  let containerManager: Record<string, unknown>;
  let ctx: AttachServiceNetworksContext;
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as AttachServiceNetworksContext['log'];

  beforeEach(() => {
    vi.clearAllMocks();
    networkManager = { connect: vi.fn().mockResolvedValue({ connected: true, alreadyConnected: false }) };
    containerManager = {};
    infraManager = { joinResourceNetworks: vi.fn().mockResolvedValue(undefined) };
    ctx = {
      networkManager: networkManager as unknown as AttachServiceNetworksContext['networkManager'],
      containerManager: containerManager as unknown as AttachServiceNetworksContext['containerManager'],
      infraManager: infraManager as unknown as AttachServiceNetworksContext['infraManager'],
      prisma: {} as unknown as AttachServiceNetworksContext['prisma'],
      infraNetworkMap: new Map(),
      environmentId: null,
      log,
    };
  });

  describe('joinNetworks + extraJoinNetworks', () => {
    it('connects to every declared joinNetworks entry', async () => {
      const def = makeServiceDef({ joinNetworks: ['db-net'] });
      await attachServiceNetworks('c1', 'worker', def, ctx);
      expect(networkManager.connect).toHaveBeenCalledWith('c1', 'db-net');
    });

    it('also connects to extraJoinNetworks — the explicit input AdoptedWeb uses for the HAProxy network', async () => {
      const def = makeServiceDef({ joinNetworks: ['db-net'] });
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, extraJoinNetworks: ['haproxy-net'] });
      const connected = networkManager.connect.mock.calls.map((call) => call[1]);
      expect(connected).toEqual(expect.arrayContaining(['db-net', 'haproxy-net']));
    });

    it('works when there are no declared joinNetworks, only extraJoinNetworks', async () => {
      const def = makeServiceDef();
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, extraJoinNetworks: ['haproxy-net'] });
      expect(networkManager.connect).toHaveBeenCalledWith('c1', 'haproxy-net');
      expect(networkManager.connect).toHaveBeenCalledTimes(1);
    });

    it('dedupes when an extraJoinNetworks entry is already declared', async () => {
      const def = makeServiceDef({ joinNetworks: ['haproxy-net'] });
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, extraJoinNetworks: ['haproxy-net'] });
      expect(networkManager.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('joinResourceNetworks + extraResourcePurposes', () => {
    it('passes only the declared purposes through when no extra purposes are given', async () => {
      const def = makeServiceDef({ joinResourceNetworks: ['applications'] });
      await attachServiceNetworks('c1', 'worker', def, ctx);
      const passedDef = infraManager.joinResourceNetworks.mock.calls[0][1] as StackServiceDefinition;
      expect(passedDef.containerConfig.joinResourceNetworks).toEqual(['applications']);
    });

    it('passes the original serviceDef reference through unmodified when there are no extra purposes', async () => {
      const def = makeServiceDef({ joinResourceNetworks: ['applications'] });
      await attachServiceNetworks('c1', 'worker', def, ctx);
      const passedDef = infraManager.joinResourceNetworks.mock.calls[0][1];
      expect(passedDef).toBe(def);
    });

    it('merges extraResourcePurposes with the declared purposes — the pool spawner input for implicit vault/nats joins', async () => {
      const def = makeServiceDef({ joinResourceNetworks: ['applications'] });
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, extraResourcePurposes: ['vault', 'nats'] });
      const passedDef = infraManager.joinResourceNetworks.mock.calls[0][1] as StackServiceDefinition;
      expect(new Set(passedDef.containerConfig.joinResourceNetworks)).toEqual(
        new Set(['applications', 'vault', 'nats']),
      );
    });

    it('dedupes when an extra purpose is already declared', async () => {
      const def = makeServiceDef({ joinResourceNetworks: ['vault'] });
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, extraResourcePurposes: ['vault'] });
      const passedDef = infraManager.joinResourceNetworks.mock.calls[0][1] as StackServiceDefinition;
      expect(passedDef.containerConfig.joinResourceNetworks).toEqual(['vault']);
    });

    it('never mutates the caller-supplied serviceDef', async () => {
      const def = makeServiceDef({ joinResourceNetworks: ['applications'] });
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, extraResourcePurposes: ['vault'] });
      expect(def.containerConfig.joinResourceNetworks).toEqual(['applications']);
    });

    it('works when there is no declared joinResourceNetworks at all, only extraResourcePurposes', async () => {
      const def = makeServiceDef();
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, extraResourcePurposes: ['vault'] });
      const passedDef = infraManager.joinResourceNetworks.mock.calls[0][1] as StackServiceDefinition;
      expect(passedDef.containerConfig.joinResourceNetworks).toEqual(['vault']);
    });
  });

  describe('egress attach', () => {
    it('always invokes attachEgressNetworkIfNeeded with the service egressBypass flag and resolved environmentId', async () => {
      const def = makeServiceDef({ egressBypass: true });
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, environmentId: 'env-1' });
      expect(mockAttachEgressNetworkIfNeeded).toHaveBeenCalledWith(
        ctx.prisma,
        ctx.containerManager,
        'c1',
        'env-1',
        true,
        log,
      );
    });

    it('normalises an undefined environmentId to null for the egress helper', async () => {
      const def = makeServiceDef();
      await attachServiceNetworks('c1', 'worker', def, { ...ctx, environmentId: undefined });
      expect(mockAttachEgressNetworkIfNeeded).toHaveBeenCalledWith(
        ctx.prisma,
        ctx.containerManager,
        'c1',
        null,
        false,
        log,
      );
    });
  });
});
