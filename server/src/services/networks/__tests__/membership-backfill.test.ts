/**
 * Focused coverage for the network overhaul Phase 9 self-heal fix in
 * `membership-backfill.ts`'s InfraResource loop: an `InfraResource` row's
 * `(scope, environmentId, purpose)` is authoritative ground truth for an
 * InfraResource-backed `ManagedNetwork` (it's only ever written by the real
 * owning producer — `StackInfraResourceManager.reconcileOutputs` /
 * `EnvironmentManager` provisioning) — so the backfill corrects a
 * `ManagedNetwork` row found by name whose identity disagrees, rather than
 * leaving it as some other producer's best-effort guess forever (the
 * `local-egress` scope='host' bug found in dev — see
 * `docs/planning/not-shipped/docker-network-overhaul-plan.md` Phase 9).
 *
 * Uses hand-rolled fake Docker/Prisma objects (mirrors `network-gc.test.ts`'s
 * pattern) rather than the real SQLite test DB — this is a narrow unit test
 * of the correction branch, not a full apply-pipeline integration test (that
 * coverage already exists in
 * `server/src/__tests__/network-membership-compiler.integration.test.ts`).
 */
import { backfillNetworkMemberships } from '../membership-backfill';
import type { DockerExecutorService } from '../../docker-executor';
import type { PrismaClient } from '../../../generated/prisma/client';

function makeDockerExecutor(existingNetworkNames: Set<string>): DockerExecutorService {
  const getNetwork = vi.fn((name: string) => ({
    inspect: () => {
      if (existingNetworkNames.has(name)) return Promise.resolve({});
      return Promise.reject(Object.assign(new Error('network not found'), { statusCode: 404 }));
    },
  }));
  return { getDockerClient: () => ({ getNetwork }) } as unknown as DockerExecutorService;
}

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

describe('backfillNetworkMemberships — InfraResource identity self-heal', () => {
  it('corrects a ManagedNetwork row a different producer created first with the wrong scope/purpose', async () => {
    const egressResource = {
      id: 'ir-1', type: 'docker-network', purpose: 'egress', scope: 'environment',
      environmentId: 'env-1', name: 'local-egress',
    };
    // Simulates the bug: a self-join's by-name fallback created this row
    // first with `scope: 'host'`/`purpose: <literal network name>` before
    // the true producer (reconcileOutputs' compiler write) ever ran.
    const wrongRow = {
      id: 'mn-1', scope: 'host', environmentId: null, stackId: null, purpose: 'local-egress', name: 'local-egress',
    };

    const managedNetworkUpdate = vi.fn().mockResolvedValue({ ...wrongRow, scope: 'environment' });
    const prisma = {
      infraResource: { findMany: vi.fn().mockResolvedValue([egressResource]) },
      managedNetwork: {
        findUnique: vi.fn().mockResolvedValue(wrongRow),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: managedNetworkUpdate,
        count: vi.fn().mockResolvedValue(1),
      },
      stack: { findMany: vi.fn().mockResolvedValue([]) },
      networkMembership: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient;

    const dockerExecutor = makeDockerExecutor(new Set(['local-egress']));

    const summary = await backfillNetworkMemberships(dockerExecutor, prisma, log);

    expect(managedNetworkUpdate).toHaveBeenCalledWith({
      where: { id: 'mn-1' },
      data: { scope: 'environment', environmentId: 'env-1', purpose: 'egress' },
    });
    // The correction branch `continue`s — the normal upsert-by-identity path
    // (which would `create` a second row) must never also run for this row.
    expect(prisma.managedNetwork.create).not.toHaveBeenCalled();
    expect(summary.infraResourcesScanned).toBe(1);
    expect(summary.danglingSkipped).toBe(0);
  });

  it('leaves an already-correct ManagedNetwork row untouched (no spurious update)', async () => {
    const vaultResource = {
      id: 'ir-2', type: 'docker-network', purpose: 'vault', scope: 'host',
      environmentId: null, name: 'mini-infra-vault',
    };
    const correctRow = {
      id: 'mn-2', scope: 'host', environmentId: null, stackId: null, purpose: 'vault', name: 'mini-infra-vault',
    };
    const managedNetworkUpdate = vi.fn();
    const prisma = {
      infraResource: { findMany: vi.fn().mockResolvedValue([vaultResource]) },
      managedNetwork: {
        findUnique: vi.fn().mockResolvedValue(correctRow),
        findFirst: vi.fn().mockResolvedValue(correctRow),
        create: vi.fn(),
        update: managedNetworkUpdate,
        count: vi.fn().mockResolvedValue(1),
      },
      stack: { findMany: vi.fn().mockResolvedValue([]) },
      networkMembership: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient;

    const dockerExecutor = makeDockerExecutor(new Set(['mini-infra-vault']));

    await backfillNetworkMemberships(dockerExecutor, prisma, log);

    expect(managedNetworkUpdate).not.toHaveBeenCalled();
    expect(prisma.managedNetwork.create).not.toHaveBeenCalled();
  });

  it('creates a fresh row via the normal path when no by-name row exists yet', async () => {
    const natsResource = {
      id: 'ir-3', type: 'docker-network', purpose: 'nats', scope: 'host',
      environmentId: null, name: 'mini-infra-nats',
    };
    const managedNetworkCreate = vi.fn().mockResolvedValue({ id: 'mn-3' });
    const prisma = {
      infraResource: { findMany: vi.fn().mockResolvedValue([natsResource]) },
      managedNetwork: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: managedNetworkCreate,
        update: vi.fn(),
        count: vi.fn().mockResolvedValue(1),
      },
      stack: { findMany: vi.fn().mockResolvedValue([]) },
      networkMembership: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient;

    const dockerExecutor = makeDockerExecutor(new Set(['mini-infra-nats']));

    await backfillNetworkMemberships(dockerExecutor, prisma, log);

    expect(managedNetworkCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'host', environmentId: null, purpose: 'nats', name: 'mini-infra-nats' }),
      }),
    );
  });

  it('seeds the mini-infra `self` membership for a joinSelf resource network the producing stack declares', async () => {
    // Regression: a dataplane-network stack that stayed `synced` across the
    // network-overhaul deploy never had `connectSelfToNetwork` write the
    // `containerName: 'self'` row (that only happens at apply time), so boot
    // convergence had nothing to reconnect after the app container was
    // recreated — stranding mini-infra off the dataplane network. The backfill
    // must seed that self-membership from the producing stack's joinSelf output.
    const dataplaneResource = {
      id: 'ir-dp', type: 'docker-network', purpose: 'dataplane', scope: 'host',
      environmentId: null, name: 'mini-infra-dataplane', stackId: 'stack-dp',
    };
    const managedNetworkCreate = vi.fn().mockResolvedValue({ id: 'mn-dp' });
    const networkMembershipCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      infraResource: { findMany: vi.fn().mockResolvedValue([dataplaneResource]) },
      managedNetwork: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: managedNetworkCreate,
        update: vi.fn(),
        count: vi.fn().mockResolvedValue(1),
      },
      // First findMany (section 1, `select: {id, resourceOutputs}`) sees the
      // producing dataplane stack; the second (section 2, per-stack membership)
      // gets `[]` so that pass is a no-op for this focused test.
      stack: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'stack-dp', resourceOutputs: [{ type: 'docker-network', purpose: 'dataplane', joinSelf: true }] },
          ])
          .mockResolvedValue([]),
      },
      networkMembership: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: networkMembershipCreate,
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaClient;

    const dockerExecutor = makeDockerExecutor(new Set(['mini-infra-dataplane']));

    await backfillNetworkMemberships(dockerExecutor, prisma, log);

    expect(networkMembershipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ containerName: 'self', networkId: 'mn-dp', source: 'system' }),
      }),
    );
  });

  it('does not seed a self membership for a resource network with no joinSelf output', async () => {
    // A per-environment `applications` network is HAProxy's/apps' network, not
    // one the mini-infra server joins — no joinSelf output, so no self row.
    const appsResource = {
      id: 'ir-app', type: 'docker-network', purpose: 'applications', scope: 'environment',
      environmentId: 'env-1', name: 'internet-applications', stackId: 'stack-hap',
    };
    const networkMembershipCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      infraResource: { findMany: vi.fn().mockResolvedValue([appsResource]) },
      managedNetwork: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'mn-app' }),
        update: vi.fn(),
        count: vi.fn().mockResolvedValue(1),
      },
      stack: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'stack-hap', resourceOutputs: [{ type: 'docker-network', purpose: 'applications', joinSelf: false }] },
          ])
          .mockResolvedValue([]),
      },
      networkMembership: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: networkMembershipCreate,
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaClient;

    const dockerExecutor = makeDockerExecutor(new Set(['internet-applications']));

    await backfillNetworkMemberships(dockerExecutor, prisma, log);

    expect(networkMembershipCreate).not.toHaveBeenCalled();
  });
});
