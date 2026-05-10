/**
 * Integration test for the orphan-JetStream cleanup hand-off introduced
 * to close the gap from #399 (`roles[].streams`):
 *
 *   - Removing a `roles[].streams[]` entry from a template deletes the
 *     `NatsStream` DB row via `pruneOrphanRoleStreams`.
 *   - Without further plumbing, the underlying JetStream stream stayed
 *     live in NATS forever (the `applyJetStreamResources` pass only
 *     iterates DB rows that *are* still present — it has no signal for
 *     "this stream used to exist and should now be gone").
 *
 * The fix: `pruneOrphanRoleStreams` now returns the captured orphan
 * names + accountId, and the orchestrator passes them to
 * `service.deleteJetStreams(...)` after `applyJetStreamResources()`. This
 * test pins the hand-off via a spy on the mocked control plane.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';

const deleteJetStreamsSpy = vi.fn(async () => undefined);

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
      applyConfig: async () => undefined,
      applyJetStreamResources: async () => undefined,
      deleteJetStreams: deleteJetStreamsSpy,
    }),
  };
});

import { runStackNatsApplyPhase } from '../services/stacks/stack-nats-apply-orchestrator';

async function seedStackWithStreams(streams: Array<{ name: string; subjects: string[] }>): Promise<{
  stackId: string;
  templateId: string;
  versionId: string;
}> {
  const templateId = createId();
  const stackId = createId();
  const versionId = createId();

  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tpl-${templateId.slice(0, 6)}`,
      displayName: 'Orphan stream cleanup test',
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
      natsRoles: [
        {
          name: 'worker',
          publish: ['x'],
          streams,
        },
      ],
    },
  });
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: `stack-orphan-${stackId.slice(0, 6)}`,
      version: 1,
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
      lastAppliedVersion: 1,
    },
  });
  return { stackId, templateId, versionId };
}

describe('orphan JetStream stream cleanup', () => {
  beforeEach(() => {
    deleteJetStreamsSpy.mockClear();
  });

  it('does not call deleteJetStreams on an apply with no orphans', async () => {
    const { stackId } = await seedStackWithStreams([
      { name: 'jobs', subjects: ['x.>'] },
    ]);
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');
    expect(deleteJetStreamsSpy).not.toHaveBeenCalled();
  });

  it('deletes orphan JS streams when a role.stream is removed on re-apply', async () => {
    // Initial: two streams A, B.
    const { stackId, templateId } = await seedStackWithStreams([
      { name: 'keep', subjects: ['k.>'] },
      { name: 'drop', subjects: ['d.>'] },
    ]);
    const first = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(first.status).toBe('applied');
    expect(deleteJetStreamsSpy).not.toHaveBeenCalled();

    // Capture the concrete name of the to-be-orphaned stream so we can
    // assert deleteJetStreams was called with it specifically.
    const dropRow = await testPrisma.natsStream.findFirst({
      where: { stackId, name: { contains: 'worker-drop' } },
    });
    expect(dropRow).not.toBeNull();
    const orphanConcreteName = dropRow!.name;

    // Edit the template — drop the second stream.
    await testPrisma.stackTemplateVersion.updateMany({
      where: { templateId, version: 1 },
      data: {
        natsRoles: [
          {
            name: 'worker',
            publish: ['x'],
            streams: [{ name: 'keep', subjects: ['k.>'] }],
          },
        ],
      },
    });

    const second = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(second.status).toBe('applied');

    // The DB row is gone.
    const remaining = await testPrisma.natsStream.findMany({ where: { stackId } });
    expect(remaining.map((r) => r.name)).toEqual([
      expect.stringContaining('worker-keep'),
    ]);

    // The orchestrator handed the orphan off to the control plane for
    // live deletion. Verifying the call captures the contract — without
    // it the JS stream would leak storage forever (the gap that #399's
    // doc addendum flagged as a known follow-up).
    expect(deleteJetStreamsSpy).toHaveBeenCalledTimes(1);
    const [accountIdArg, namesArg] = deleteJetStreamsSpy.mock.calls[0]!;
    expect(typeof accountIdArg).toBe('string');
    expect(namesArg).toEqual([orphanConcreteName]);
  });

  it("apply succeeds even if deleteJetStreams throws — DB is authoritative, NATS-side cleanup is best-effort", async () => {
    deleteJetStreamsSpy.mockRejectedValueOnce(new Error('NATS unreachable'));

    const { stackId, templateId } = await seedStackWithStreams([
      { name: 'keep', subjects: ['k.>'] },
      { name: 'drop', subjects: ['d.>'] },
    ]);
    await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    deleteJetStreamsSpy.mockClear();
    deleteJetStreamsSpy.mockRejectedValueOnce(new Error('NATS unreachable'));

    await testPrisma.stackTemplateVersion.updateMany({
      where: { templateId, version: 1 },
      data: {
        natsRoles: [
          {
            name: 'worker',
            publish: ['x'],
            streams: [{ name: 'keep', subjects: ['k.>'] }],
          },
        ],
      },
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');
    expect(deleteJetStreamsSpy).toHaveBeenCalledTimes(1);
    // DB row still gone — the prune ran before deleteJetStreams threw.
    const remaining = await testPrisma.natsStream.findMany({ where: { stackId } });
    expect(remaining).toHaveLength(1);
  });
});
