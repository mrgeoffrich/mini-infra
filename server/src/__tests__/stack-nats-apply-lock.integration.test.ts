/**
 * Integration tests for the NATS-apply lock — the single-host serializer
 * that prevents producer + consumer races on `lastAppliedNatsSnapshot`.
 *
 * Coverage:
 *   - Concurrent applies are serialized (max in-flight = 1).
 *   - One apply's failure doesn't break the chain — subsequent applies
 *     still queue and complete.
 *   - The chain drains cleanly after all in-flight work finishes.
 *
 * The mocked control plane injects a delay into `applyConfig` so the test
 * can observe the lock holding the second apply until the first one
 * finishes its network-call phase. Without the lock the two applies would
 * interleave and the in-flight counter would briefly reach 2.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';

let inFlight = 0;
let maxInFlight = 0;
let applyConfigDelayMs = 0;
let applyConfigShouldFail = false;

/** Reset the cross-test counters/knobs the mock reads from. */
function resetMockState() {
  inFlight = 0;
  maxInFlight = 0;
  applyConfigDelayMs = 0;
  applyConfigShouldFail = false;
}

vi.mock('../services/nats/nats-control-plane-service', async (orig) => {
  const real = await orig<typeof import('../services/nats/nats-control-plane-service')>();
  return {
    ...real,
    getNatsControlPlaneService: (db: unknown) => ({
      getStatus: async () => ({ configured: true }),
      ensureDefaultAccount: async () => {
        const prisma = db as typeof testPrisma;
        const existing = await prisma.natsAccount.findUnique({ where: { name: 'default' } });
        if (existing) return { id: existing.id, name: existing.name, isSystem: true };
        const created = await prisma.natsAccount.create({
          data: {
            name: 'default',
            displayName: 'Default',
            isSystem: true,
            seedKvPath: 'shared/nats-default',
          },
        });
        return { id: created.id, name: created.name, isSystem: true };
      },
      // applyConfig is the slow step where the lock contention matters most.
      // Track in-flight count + max-in-flight to assert serialization.
      applyConfig: async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        try {
          if (applyConfigDelayMs > 0) {
            await new Promise((r) => setTimeout(r, applyConfigDelayMs));
          }
          if (applyConfigShouldFail) {
            throw new Error('mock applyConfig failure');
          }
        } finally {
          inFlight--;
        }
      },
      applyJetStreamResources: async () => undefined,
    }),
  };
});

import {
  runStackNatsApplyPhase,
  __waitForNatsApplyChainDrainForTests,
} from '../services/stacks/stack-nats-apply-orchestrator';

interface SeedInput {
  stackName?: string;
}

async function seedNatsBearingStack(input: SeedInput = {}): Promise<{ stackId: string }> {
  const templateId = createId();
  const stackId = createId();
  const versionId = createId();

  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tpl-${templateId.slice(0, 6)}`,
      displayName: 'Apply lock test',
      source: 'user',
      scope: 'host',
    },
  });
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId,
      version: 1,
      status: 'published',
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
    },
  });
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: input.stackName ?? `stack-${stackId.slice(0, 6)}`,
      version: 1,
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
    },
  });
  return { stackId };
}

describe('runStackNatsApplyPhase — apply lock', () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
  });

  it('serializes two concurrent applies (max in-flight stays at 1)', async () => {
    applyConfigDelayMs = 60;
    const a = await seedNatsBearingStack({ stackName: `lock-a-${Date.now()}` });
    const b = await seedNatsBearingStack({ stackName: `lock-b-${Date.now()}` });

    const [resultA, resultB] = await Promise.all([
      runStackNatsApplyPhase(testPrisma, a.stackId, { triggeredBy: undefined }),
      runStackNatsApplyPhase(testPrisma, b.stackId, { triggeredBy: undefined }),
    ]);

    expect(resultA.status).toBe('applied');
    expect(resultB.status).toBe('applied');
    // Without the lock, both applyConfig calls would overlap and maxInFlight
    // would briefly hit 2. The whole-phase lock serializes them.
    expect(maxInFlight).toBe(1);
  });

  it('a failed apply does not poison the chain — subsequent applies still complete', async () => {
    const a = await seedNatsBearingStack({ stackName: `pois-a-${Date.now()}` });
    const b = await seedNatsBearingStack({ stackName: `pois-b-${Date.now()}` });

    // First apply: forced failure inside applyConfig.
    applyConfigShouldFail = true;
    const resultA = await runStackNatsApplyPhase(testPrisma, a.stackId, { triggeredBy: undefined });
    expect(resultA.status).toBe('error');
    expect(resultA.error).toContain('mock applyConfig failure');

    // Second apply: clean run — must not be blocked or rejected by the
    // first apply's failure propagating through the chain.
    applyConfigShouldFail = false;
    const resultB = await runStackNatsApplyPhase(testPrisma, b.stackId, { triggeredBy: undefined });
    expect(resultB.status).toBe('applied');
  });

  it('chain drains cleanly after all in-flight applies finish', async () => {
    applyConfigDelayMs = 30;
    const stacks = await Promise.all([
      seedNatsBearingStack({ stackName: `drain-1-${Date.now()}` }),
      seedNatsBearingStack({ stackName: `drain-2-${Date.now()}` }),
      seedNatsBearingStack({ stackName: `drain-3-${Date.now()}` }),
    ]);

    const all = Promise.all(
      stacks.map((s) => runStackNatsApplyPhase(testPrisma, s.stackId, { triggeredBy: undefined })),
    );
    await all;
    await __waitForNatsApplyChainDrainForTests();

    // After drain, in-flight is back to zero — nothing leaked into the
    // chain that would keep it busy.
    expect(inFlight).toBe(0);
    expect(maxInFlight).toBe(1);
  });
});
