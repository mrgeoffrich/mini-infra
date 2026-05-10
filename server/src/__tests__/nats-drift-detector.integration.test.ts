/**
 * Integration tests for `detectNatsDrift` — the NATS-section drift surface
 * that compares a stack's current template version raw NATS fields against
 * the snapshot recorded at last apply. Lives behind the stack-list API
 * field (`StackInfo.natsDrift`).
 *
 * Coverage:
 *   - No snapshot → null (never applied; drift signal would be misleading).
 *   - No NATS section on the current template → null.
 *   - Matching template + snapshot → not drifted.
 *   - Role added → drifted with `roles` reason.
 *   - Role removed → drifted with `roles` reason.
 *   - Role pub list re-ordered → drifted (ordering matters; pub permissions
 *     are positional in NATS).
 *   - Signer scope changed → drifted with `signers` reason.
 *   - Imports/exports diff → drifted with the right reason.
 *   - Subject prefix changed (raw level) → drifted with `subject-prefix` reason.
 *   - Old snapshot missing raw subjectPrefix/exports → emits `baseline-incomplete`
 *     so the UI can render "drift status unknown — re-apply to refresh baseline".
 *   - Corrupt JSON snapshot → null (caller falls back to other diagnostic state).
 */

import { describe, it, expect } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';
import { detectNatsDrift } from '../services/stacks/nats-drift-detector';

interface SeedInput {
  natsRoles?: unknown;
  natsSigners?: unknown;
  natsExports?: unknown;
  natsImports?: unknown;
  natsSubjectPrefix?: string | null;
  /** When provided, written to `stack.lastAppliedNatsSnapshot` verbatim. */
  snapshot?: unknown;
}

async function seedStackWithSnapshot(input: SeedInput): Promise<{
  templateId: string;
  templateVersion: number;
  lastAppliedNatsSnapshot: string | null;
}> {
  const templateId = createId();
  const versionId = createId();
  const stackId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tpl-${templateId.slice(0, 6)}`,
      displayName: 'Drift detector test',
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
      natsRoles: (input.natsRoles ?? null) as never,
      natsSigners: (input.natsSigners ?? null) as never,
      natsExports: (input.natsExports ?? null) as never,
      natsImports: (input.natsImports ?? null) as never,
      natsSubjectPrefix: input.natsSubjectPrefix ?? null,
    },
  });
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: `stack-${stackId.slice(0, 6)}`,
      version: 1,
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
      lastAppliedNatsSnapshot: input.snapshot !== undefined ? JSON.stringify(input.snapshot) : null,
    },
  });
  return { templateId, templateVersion: 1, lastAppliedNatsSnapshot: input.snapshot !== undefined ? JSON.stringify(input.snapshot) : null };
}

/** Build a snapshot value with the v2 raw fields populated. */
function snapshotV2(args: {
  subjectPrefixRaw?: string | null;
  roles?: unknown;
  signers?: unknown;
  exportsRaw?: unknown;
  imports?: unknown;
}) {
  return {
    accounts: [],
    credentials: [],
    streams: [],
    consumers: [],
    resources: [],
    subjectPrefix: args.subjectPrefixRaw ?? 'app.x',
    roles: args.roles ?? [],
    signers: args.signers ?? [],
    resolvedExports: (args.exportsRaw as unknown[] | undefined)?.map((s) => `app.x.${s}`) ?? [],
    imports: args.imports ?? [],
    subjectPrefixRaw: args.subjectPrefixRaw ?? null,
    exportsRaw: args.exportsRaw ?? [],
  };
}

describe('detectNatsDrift', () => {
  it('returns null when the stack has no NATS apply snapshot', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      // snapshot omitted intentionally
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result).toBeNull();
  });

  it('returns null when the current template has no NATS section at all', async () => {
    const seeded = await seedStackWithSnapshot({
      // No NATS fields on the current template version
      snapshot: snapshotV2({ subjectPrefixRaw: null, roles: [{ name: 'old' }] }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result).toBeNull();
  });

  it('returns not-drifted when current template matches snapshot exactly', async () => {
    const roles = [{ name: 'gateway', publish: ['agent.in'], subscribe: ['slack.api'] }];
    const seeded = await seedStackWithSnapshot({
      natsRoles: roles,
      snapshot: snapshotV2({ roles, subjectPrefixRaw: null, exportsRaw: [] }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result).toEqual({ drifted: false, reasons: [] });
  });

  it('reports drift when a role is added', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [
        { name: 'gateway', publish: ['x'] },
        { name: 'manager', publish: ['y'] },
      ],
      snapshot: snapshotV2({
        subjectPrefixRaw: null,
        roles: [{ name: 'gateway', publish: ['x'] }],
        exportsRaw: [],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('roles');
  });

  it('reports drift when a role is removed', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      snapshot: snapshotV2({
        subjectPrefixRaw: null,
        roles: [
          { name: 'gateway', publish: ['x'] },
          { name: 'manager', publish: ['y'] },
        ],
        exportsRaw: [],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('roles');
  });

  it('reports drift when a role.publish entry is reordered (pub permissions are positional)', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['a.in', 'b.in'] }],
      snapshot: snapshotV2({
        subjectPrefixRaw: null,
        roles: [{ name: 'gateway', publish: ['b.in', 'a.in'] }],
        exportsRaw: [],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('roles');
  });

  it('reports drift when signer scope changes', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      natsSigners: [{ name: 'minter', subjectScope: 'agent.worker.v2' }],
      snapshot: snapshotV2({
        subjectPrefixRaw: null,
        roles: [{ name: 'gateway', publish: ['x'] }],
        signers: [{ name: 'minter', subjectScope: 'agent.worker.v1' }],
        exportsRaw: [],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('signers');
  });

  it('reports drift when exports change', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'pub', publish: ['x'] }],
      natsExports: ['events.>', 'metrics.>'],
      snapshot: snapshotV2({
        subjectPrefixRaw: null,
        roles: [{ name: 'pub', publish: ['x'] }],
        exportsRaw: ['events.>'],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('exports');
  });

  it('reports drift when imports change', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'watcher', subscribe: ['x'] }],
      natsImports: [{ fromStack: 'producer', subjects: ['events.foo'], forRoles: ['watcher'] }],
      snapshot: snapshotV2({
        subjectPrefixRaw: null,
        roles: [{ name: 'watcher', subscribe: ['x'] }],
        imports: [],
        exportsRaw: [],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('imports');
  });

  it('reports drift when raw subjectPrefix changes (template-level edit)', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      natsSubjectPrefix: 'navi-v2',
      snapshot: snapshotV2({
        subjectPrefixRaw: 'navi-v1',
        roles: [{ name: 'gateway', publish: ['x'] }],
        exportsRaw: [],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('subject-prefix');
  });

  it("treats null and [] as equivalent for empty NATS arrays (no false-positive drift)", async () => {
    // The orchestrator writes `natsRoles: null` for no-roles templates but
    // a freshly-edited template might end up with `[]` after schema parse.
    // Without nullish coalescing the detector would false-positive on what
    // is structurally identical state.
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      natsSigners: [],  // empty array
      snapshot: snapshotV2({
        subjectPrefixRaw: null,
        roles: [{ name: 'gateway', publish: ['x'] }],
        signers: null,  // null on the snapshot side
        exportsRaw: [],
      }),
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(false);
    expect(result?.reasons).toEqual([]);
  });

  it('emits baseline-incomplete when the snapshot predates the raw-fields bump', async () => {
    // Old-format snapshot — no `subjectPrefixRaw` or `exportsRaw`. Detector
    // can still compare roles/signers/imports raw-to-raw, but for fields
    // that need the raw baseline it surfaces the gap.
    const oldSnapshot = {
      accounts: [],
      credentials: [],
      streams: [],
      consumers: [],
      resources: [],
      subjectPrefix: 'app.x',
      roles: [{ name: 'gateway', publish: ['x'] }],
      signers: [],
      resolvedExports: [],
      imports: [],
      // NOTE: no subjectPrefixRaw / exportsRaw
    };
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      snapshot: oldSnapshot,
    });
    const result = await detectNatsDrift(testPrisma, seeded);
    expect(result?.drifted).toBe(true);
    expect(result?.reasons).toContain('baseline-incomplete');
    // Should NOT also mis-fire on subject-prefix or exports — those are
    // skipped when raw isn't available, in favour of the explicit baseline
    // signal.
    expect(result?.reasons).not.toContain('subject-prefix');
    expect(result?.reasons).not.toContain('exports');
  });

  it('returns null on a corrupt JSON snapshot (caller falls back to other state)', async () => {
    const seeded = await seedStackWithSnapshot({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
    });
    // Overwrite the snapshot column with garbage to simulate corruption.
    const stackId = (
      await testPrisma.stack.findFirst({
        where: { templateId: seeded.templateId },
        select: { id: true },
      })
    )!.id;
    await testPrisma.stack.update({
      where: { id: stackId },
      data: { lastAppliedNatsSnapshot: '{ not valid json' },
    });

    const result = await detectNatsDrift(testPrisma, {
      templateId: seeded.templateId,
      templateVersion: seeded.templateVersion,
      lastAppliedNatsSnapshot: '{ not valid json',
    });
    expect(result).toBeNull();
  });
});
