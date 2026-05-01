/**
 * Integration tests for Phase 5 — cross-stack imports/exports in
 * `runStackNatsApplyPhase`.
 *
 * Coverage:
 *   - Producer applies with `nats.exports[]` → resolved (prefixed) exports
 *     land in `lastAppliedNatsSnapshot`.
 *   - Consumer with `nats.imports[]` → matching subject lands on the
 *     `forRoles` role's subscribeAllow (and ONLY those roles, per design).
 *   - Producer not yet applied → consumer apply fails clean.
 *   - Producer doesn't export a matching pattern → consumer apply fails clean.
 *   - Self-import (consumer === producer) → rejected.
 *   - Subject-pattern matcher unit checks (>, *, equality, mismatch).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';

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
    }),
  };
});

import {
  runStackNatsApplyPhase,
  __testing,
} from '../services/stacks/stack-nats-apply-orchestrator';

interface SeedStackInput {
  natsRoles?: unknown;
  natsExports?: unknown;
  natsImports?: unknown;
  natsSubjectPrefix?: string | null;
  templateName?: string;
  stackName?: string;
}

async function seedStack(input: SeedStackInput): Promise<{ stackId: string; templateId: string }> {
  const templateId = createId();
  const stackId = createId();
  const versionId = createId();

  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: input.templateName ?? `tpl-${templateId.slice(0, 6)}`,
      displayName: 'Phase 5 test template',
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
      natsRoles: input.natsRoles ?? null,
      natsExports: input.natsExports ?? null,
      natsImports: input.natsImports ?? null,
      natsSubjectPrefix: input.natsSubjectPrefix ?? null,
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
      lastAppliedVersion: 1,
    },
  });
  return { stackId, templateId };
}

// ─── Subject matcher unit checks ─────────────────────────────────────────────

describe('Phase 5 — natsSubjectMatches', () => {
  const m = __testing.natsSubjectMatches;

  it('exact match', () => expect(m('a.b.c', 'a.b.c')).toBe(true));
  it('exact mismatch', () => expect(m('a.b.c', 'a.b.d')).toBe(false));
  it('* matches one token', () => expect(m('a.*.c', 'a.b.c')).toBe(true));
  it('* does not match two tokens', () => expect(m('a.*.c', 'a.b.x.c')).toBe(false));
  it('> matches one or more tail tokens', () => expect(m('a.>', 'a.b')).toBe(true));
  it('> matches multi-token tail', () => expect(m('a.>', 'a.b.c.d')).toBe(true));
  it('> does not match shorter subject', () => expect(m('a.>', 'a')).toBe(false));
  it('> only valid at end (treats midway as no-match)', () =>
    expect(m('a.>.c', 'a.b.c')).toBe(false));
  it('subject longer than pattern without > → no match', () =>
    expect(m('a.b', 'a.b.c')).toBe(false));
});

// ─── Cross-stack apply flow ──────────────────────────────────────────────────

describe('runStackNatsApplyPhase — Phase 5 imports/exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('producer apply writes resolved exports to lastAppliedNatsSnapshot', async () => {
    const { stackId } = await seedStack({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      natsExports: ['events.>'],
      stackName: `producer-${Date.now()}`,
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');
    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    const snap = JSON.parse(stack!.lastAppliedNatsSnapshot!);
    expect(snap.subjectPrefix).toBe(`app.${stackId}`);
    expect(snap.resolvedExports).toEqual([`app.${stackId}.events.>`]);
  });

  it('consumer import lands on only the forRoles role and is absolute (producer-prefixed)', async () => {
    const producer = await seedStack({
      natsRoles: [{ name: 'pub', publish: ['x'] }],
      natsExports: ['events.>'],
      stackName: `producer-imp-${Date.now()}`,
    });
    await runStackNatsApplyPhase(testPrisma, producer.stackId, { triggeredBy: undefined });

    const producerName = (await testPrisma.stack.findUnique({ where: { id: producer.stackId } }))!.name;

    const consumer = await seedStack({
      natsRoles: [
        { name: 'watcher', subscribe: ['internal'] },
        { name: 'admin', subscribe: ['internal'] },
      ],
      natsImports: [{ fromStack: producerName, subjects: ['events.foo'], forRoles: ['watcher'] }],
      stackName: `consumer-${Date.now()}`,
    });
    const result = await runStackNatsApplyPhase(testPrisma, consumer.stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');

    const watcherProfile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'watcher' } },
    });
    const adminProfile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'admin' } },
    });
    const watcherSub = watcherProfile!.subscribeAllow as unknown as string[];
    const adminSub = adminProfile!.subscribeAllow as unknown as string[];

    // watcher gets the imported subject (absolute, producer-prefixed).
    expect(watcherSub).toContain(`app.${producer.stackId}.events.foo`);
    // admin does NOT get it — per-role binding only.
    expect(adminSub).not.toContain(`app.${producer.stackId}.events.foo`);
  });

  it('consumer can also import a wildcard pattern that the producer exported', async () => {
    const producer = await seedStack({
      natsRoles: [{ name: 'pub', publish: ['x'] }],
      natsExports: ['events.>'],
      stackName: `producer-wild-${Date.now()}`,
    });
    await runStackNatsApplyPhase(testPrisma, producer.stackId, { triggeredBy: undefined });

    const producerName = (await testPrisma.stack.findUnique({ where: { id: producer.stackId } }))!.name;
    const consumer = await seedStack({
      natsRoles: [{ name: 'watcher', subscribe: ['x'] }],
      natsImports: [{ fromStack: producerName, subjects: ['events.>'], forRoles: ['watcher'] }],
      stackName: `consumer-wild-${Date.now()}`,
    });
    const result = await runStackNatsApplyPhase(testPrisma, consumer.stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');

    const profile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'watcher' } },
    });
    const sub = profile!.subscribeAllow as unknown as string[];
    expect(sub).toContain(`app.${producer.stackId}.events.>`);
  });

  it('producer not applied → consumer apply fails clean', async () => {
    const producer = await seedStack({
      natsExports: ['events.>'],
      stackName: `producer-unapplied-${Date.now()}`,
    });
    // NOTE: producer is intentionally not applied
    const producerName = (await testPrisma.stack.findUnique({ where: { id: producer.stackId } }))!.name;

    const consumer = await seedStack({
      natsRoles: [{ name: 'watcher', subscribe: ['x'] }],
      natsImports: [{ fromStack: producerName, subjects: ['events.foo'], forRoles: ['watcher'] }],
      stackName: `consumer-noapply-${Date.now()}`,
    });
    const result = await runStackNatsApplyPhase(testPrisma, consumer.stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/no applied NATS snapshot|did not export any subjects/);
  });

  it('producer does not export a matching pattern → consumer apply fails with structured error', async () => {
    const producer = await seedStack({
      natsRoles: [{ name: 'pub', publish: ['x'] }],
      natsExports: ['metrics.>'],  // exports metrics, not events
      stackName: `producer-mismatch-${Date.now()}`,
    });
    await runStackNatsApplyPhase(testPrisma, producer.stackId, { triggeredBy: undefined });

    const producerName = (await testPrisma.stack.findUnique({ where: { id: producer.stackId } }))!.name;
    const consumer = await seedStack({
      natsRoles: [{ name: 'watcher', subscribe: ['x'] }],
      natsImports: [{ fromStack: producerName, subjects: ['events.foo'], forRoles: ['watcher'] }],
      stackName: `consumer-mismatch-${Date.now()}`,
    });
    const result = await runStackNatsApplyPhase(testPrisma, consumer.stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/does not match any export/);
  });

  it('non-existent producer → consumer apply fails clean', async () => {
    const consumer = await seedStack({
      natsRoles: [{ name: 'watcher', subscribe: ['x'] }],
      natsImports: [{ fromStack: 'no-such-stack', subjects: ['events.foo'], forRoles: ['watcher'] }],
    });
    const result = await runStackNatsApplyPhase(testPrisma, consumer.stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found/);
  });

  it('a stack can both export AND import in the same apply (mixed producer+consumer)', async () => {
    // Producer A exports events.>; consumer B imports from A AND also
    // exports its own metrics.>; consumer C imports from B's metrics.
    // Verifies the resolved-exports + imports paths run together cleanly
    // for a stack acting as both endpoints.
    const aProducer = await seedStack({
      natsRoles: [{ name: 'pub', publish: ['x'] }],
      natsExports: ['events.>'],
      stackName: `chain-a-${Date.now()}`,
    });
    await runStackNatsApplyPhase(testPrisma, aProducer.stackId, { triggeredBy: undefined });
    const aName = (await testPrisma.stack.findUnique({ where: { id: aProducer.stackId } }))!.name;

    const bMixed = await seedStack({
      natsRoles: [{ name: 'watcher', subscribe: ['internal'] }],
      natsImports: [{ fromStack: aName, subjects: ['events.foo'], forRoles: ['watcher'] }],
      natsExports: ['metrics.>'],
      stackName: `chain-b-${Date.now()}`,
    });
    const bResult = await runStackNatsApplyPhase(testPrisma, bMixed.stackId, { triggeredBy: undefined });
    expect(bResult.status).toBe('applied');

    const bSnap = JSON.parse(
      (await testPrisma.stack.findUnique({ where: { id: bMixed.stackId } }))!.lastAppliedNatsSnapshot!,
    );
    // B's own export landed in its snapshot.
    expect(bSnap.resolvedExports).toEqual([`app.${bMixed.stackId}.metrics.>`]);
    // B's watcher role gets A's events.foo on subscribe (absolute, A-prefixed).
    const bWatcherProfile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'watcher' } },
    });
    const bSub = bWatcherProfile!.subscribeAllow as unknown as string[];
    expect(bSub).toContain(`app.${aProducer.stackId}.events.foo`);

    // A third stack C imports from B's metrics — verifies B's resolvedExports
    // is consumable by another stack.
    const bName = (await testPrisma.stack.findUnique({ where: { id: bMixed.stackId } }))!.name;
    const cConsumer = await seedStack({
      natsRoles: [{ name: 'metrics-watcher', subscribe: ['x'] }],
      natsImports: [
        { fromStack: bName, subjects: ['metrics.cpu'], forRoles: ['metrics-watcher'] },
      ],
      stackName: `chain-c-${Date.now()}`,
    });
    const cResult = await runStackNatsApplyPhase(testPrisma, cConsumer.stackId, { triggeredBy: undefined });
    expect(cResult.status).toBe('applied');
    const cWatcherProfile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'metrics-watcher' } },
    });
    const cSub = cWatcherProfile!.subscribeAllow as unknown as string[];
    expect(cSub).toContain(`app.${bMixed.stackId}.metrics.cpu`);
  });

  it('imports[].forRoles referencing an undeclared role → apply fails (defense in depth)', async () => {
    const producer = await seedStack({
      natsRoles: [{ name: 'pub', publish: ['x'] }],
      natsExports: ['events.>'],
      stackName: `producer-bad-forroles-${Date.now()}`,
    });
    await runStackNatsApplyPhase(testPrisma, producer.stackId, { triggeredBy: undefined });

    const producerName = (await testPrisma.stack.findUnique({ where: { id: producer.stackId } }))!.name;
    const consumer = await seedStack({
      // Note: declares no roles, but imports[].forRoles references one.
      natsRoles: [{ name: 'watcher', subscribe: ['x'] }],
      natsImports: [{ fromStack: producerName, subjects: ['events.foo'], forRoles: ['notARealRole'] }],
    });
    const result = await runStackNatsApplyPhase(testPrisma, consumer.stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/undeclared role/);
  });
});
