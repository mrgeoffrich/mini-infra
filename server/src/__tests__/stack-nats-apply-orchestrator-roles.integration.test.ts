/**
 * Integration tests for Phase 3 — role materialization in
 * `runStackNatsApplyPhase`. The control-plane service is mocked because we
 * don't want to talk to a real NATS server in unit/integration suite, but
 * everything else (Prisma writes, allowlist read, prefix resolution,
 * template engine) is real.
 *
 * What's covered:
 *   - Default prefix `app.<stack.id>` materializes roles with prefixed perms
 *   - `inboxAuto: 'both' | 'reply' | 'request' | 'none'` injects `_INBOX.>`
 *     in the right list(s)
 *   - Service `natsRole` resolves to the materialized NatsCredentialProfile
 *   - Non-default prefix without an allowlist entry → apply fails
 *   - Non-default prefix WITH an allowlist entry → apply succeeds
 *   - Two stacks with overlapping role names get distinct profiles + prefixes
 *   - Legacy `nats.credentials` path still works unchanged
 *   - Defense-in-depth: a corrupted (escape-pattern) role permission stored
 *     in the DB is rejected at apply
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';

// Mock the NATS control plane: tests don't need a live server. We only care
// about what gets written to Prisma.
vi.mock('../services/nats/nats-control-plane-service', async (orig) => {
  const real = await orig<typeof import('../services/nats/nats-control-plane-service')>();
  return {
    ...real,
    getNatsControlPlaneService: (db: unknown) => ({
      getStatus: async () => ({ configured: true }),
      ensureDefaultAccount: async () => {
        // Use the test prisma's record if it exists; else create one.
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

import { runStackNatsApplyPhase } from '../services/stacks/stack-nats-apply-orchestrator';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface SeedStackInput {
  natsRoles?: unknown;
  natsSubjectPrefix?: string | null;
  natsCredentials?: unknown;
  natsAccounts?: unknown;
  serviceNatsRole?: string | null;
  serviceNatsCredentialRef?: string | null;
  templateName?: string;
  stackName?: string;
}

async function seedStack(input: SeedStackInput): Promise<{ stackId: string; templateId: string; serviceId: string }> {
  const templateId = createId();
  const stackId = createId();
  const versionId = createId();
  const serviceId = createId();

  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: input.templateName ?? `tpl-${templateId.slice(0, 6)}`,
      displayName: 'Phase 3 test template',
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
      natsAccounts: input.natsAccounts ?? null,
      natsCredentials: input.natsCredentials ?? null,
      natsRoles: input.natsRoles ?? null,
      natsSubjectPrefix: input.natsSubjectPrefix ?? null,
    },
  });
  await testPrisma.stackTemplateService.create({
    data: {
      versionId,
      serviceName: 'manager',
      serviceType: 'Stateful',
      dockerImage: 'app',
      dockerTag: 'latest',
      containerConfig: {},
      dependsOn: [],
      order: 0,
      natsRole: input.serviceNatsRole ?? null,
      natsCredentialRef: input.serviceNatsCredentialRef ?? null,
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
      services: {
        create: {
          id: serviceId,
          serviceName: 'manager',
          serviceType: 'Stateful',
          dockerImage: 'app',
          dockerTag: 'latest',
          containerConfig: {},
          configFiles: [],
          dependsOn: [],
          order: 0,
        },
      },
    },
  });
  return { stackId, templateId, serviceId };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runStackNatsApplyPhase — Phase 3 role materialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('default prefix `app.<stackId>` is auto-applied; role permissions are prefix-prepended', async () => {
    const { stackId } = await seedStack({
      natsRoles: [
        {
          name: 'gateway',
          publish: ['agent.in'],
          subscribe: ['slack.api'],
          inboxAuto: 'both',
        },
      ],
      serviceNatsRole: 'gateway',
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: 'test-user' });
    expect(result.status).toBe('applied');

    const profile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'gateway' } },
    });
    expect(profile).not.toBeNull();
    const expectedPrefix = `app.${stackId}`;
    expect(profile!.publishAllow).toEqual([`${expectedPrefix}.agent.in`, '_INBOX.>']);
    expect(profile!.subscribeAllow).toEqual([`${expectedPrefix}.slack.api`, '_INBOX.>']);
  });

  it('service.natsRole binds the materialized credential profile', async () => {
    const { stackId, serviceId } = await seedStack({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      serviceNatsRole: 'gateway',
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: 'test-user' });
    expect(result.status).toBe('applied');
    expect(result.servicesBound).toBe(1);

    const svc = await testPrisma.stackService.findUnique({ where: { id: serviceId } });
    expect(svc!.natsCredentialId).not.toBeNull();
    const profile = await testPrisma.natsCredentialProfile.findUnique({
      where: { id: svc!.natsCredentialId! },
    });
    expect(profile!.name).toContain('gateway');
  });

  it.each([
    ['both', { pubInbox: true, subInbox: true }],
    ['reply', { pubInbox: true, subInbox: false }],
    ['request', { pubInbox: false, subInbox: true }],
    ['none', { pubInbox: false, subInbox: false }],
  ])('inboxAuto=%s injects _INBOX.> correctly', async (inboxAuto, expected) => {
    const { stackId } = await seedStack({
      natsRoles: [
        { name: 'gateway', publish: ['agent.in'], subscribe: ['slack.api'], inboxAuto },
      ],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: null as never });
    expect(result.status).toBe('applied');

    const profile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'gateway' } },
    });
    const pub = profile!.publishAllow as unknown as string[];
    const sub = profile!.subscribeAllow as unknown as string[];
    expect(pub.includes('_INBOX.>')).toBe(expected.pubInbox);
    expect(sub.includes('_INBOX.>')).toBe(expected.subInbox);
  });

  it('kvBuckets adds the JS.API.STREAM.INFO lookup grant alongside $KV.<bucket>.>', async () => {
    // ALT-28 follow-up: the SDK's KV view binds by calling stream-info on
    // the underlying `KV_<bucket>` stream before the first Put/Get. Without
    // a publish grant on `$JS.API.STREAM.INFO.KV_<bucket>` the bind fails
    // with "Permissions Violation" and the heartbeat path silently breaks.
    // This test pins both grants — `$KV.<bucket>.>` (Put) AND the stream-info
    // lookup — so a future regression that drops one shows up here.
    const { stackId } = await seedStack({
      natsRoles: [
        {
          name: 'gw',
          publish: ['x'],
          kvBuckets: ['egress-gw-health'],
          inboxAuto: 'both',
        },
      ],
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');

    const profile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'gw' } },
    });
    const pub = profile!.publishAllow as unknown as string[];
    const sub = profile!.subscribeAllow as unknown as string[];
    expect(pub).toContain('$KV.egress-gw-health.>');
    expect(pub).toContain('$JS.API.STREAM.INFO.KV_egress-gw-health');
    // KV reads need subscribe access too — get/watch flow through `$KV.<bucket>.>`.
    expect(sub).toContain('$KV.egress-gw-health.>');
  });

  it('roles without kvBuckets get no $KV / $JS.API publish grants', async () => {
    // Negative pin: the kvBuckets injection only fires when the role
    // declares a bucket. A role without one must not inherit any system-tree
    // grants — defence-in-depth against a future change accidentally
    // broadening the grant set.
    const { stackId } = await seedStack({
      natsRoles: [
        { name: 'gw', publish: ['x'], inboxAuto: 'both' },
      ],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');

    const profile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'gw' } },
    });
    const pub = profile!.publishAllow as unknown as string[];
    expect(pub.some((s) => s.startsWith('$KV.'))).toBe(false);
    expect(pub.some((s) => s.startsWith('$JS.API.'))).toBe(false);
  });

  it('two stacks with the same role name get distinct profiles with non-overlapping prefixes', async () => {
    const a = await seedStack({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      stackName: `stack-a-${Date.now()}`,
    });
    const b = await seedStack({
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
      stackName: `stack-b-${Date.now()}`,
    });

    await runStackNatsApplyPhase(testPrisma, a.stackId, { triggeredBy: undefined });
    await runStackNatsApplyPhase(testPrisma, b.stackId, { triggeredBy: undefined });

    const profileA = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: a.stackId.slice(0, 8).toLowerCase() } },
    });
    const profileB = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: b.stackId.slice(0, 8).toLowerCase() } },
    });
    expect(profileA).not.toBeNull();
    expect(profileB).not.toBeNull();
    expect(profileA!.id).not.toBe(profileB!.id);
    const pubA = profileA!.publishAllow as unknown as string[];
    const pubB = profileB!.publishAllow as unknown as string[];
    expect(pubA[0]).toContain(`app.${a.stackId}`);
    expect(pubB[0]).toContain(`app.${b.stackId}`);
    expect(pubA[0]).not.toBe(pubB[0]);
  });
});

describe('runStackNatsApplyPhase — Phase 3 prefix allowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('non-default subjectPrefix without an allowlist entry → apply fails with structured error', async () => {
    const { stackId } = await seedStack({
      natsSubjectPrefix: 'navi-no-allowlist',
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toContain('allowlist');
  });

  it('non-default subjectPrefix WITH an allowlist entry that names this template → succeeds', async () => {
    const { stackId, templateId } = await seedStack({
      natsSubjectPrefix: 'navi-allowlisted',
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
    });
    await testPrisma.systemSettings.create({
      data: {
        category: 'nats-prefix-allowlist',
        key: 'navi-allowlisted',
        value: JSON.stringify({ allowedTemplateIds: [templateId] }),
        isEncrypted: false,
        isActive: true,
        createdBy: 'test',
        updatedBy: 'test',
      },
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');

    const profile = await testPrisma.natsCredentialProfile.findFirst({
      where: { name: { contains: 'gateway' } },
    });
    const pub = profile!.publishAllow as unknown as string[];
    expect(pub[0]).toBe('navi-allowlisted.x');
  });

  it('non-default subjectPrefix WITH allowlist entry that does NOT name this template → fails', async () => {
    const { stackId } = await seedStack({
      natsSubjectPrefix: 'navi-other-template',
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
    });
    // Allowlist entry exists but for a different template ID.
    await testPrisma.systemSettings.create({
      data: {
        category: 'nats-prefix-allowlist',
        key: 'navi-other-template',
        value: JSON.stringify({ allowedTemplateIds: ['some-other-template-id'] }),
        isEncrypted: false,
        isActive: true,
        createdBy: 'test',
        updatedBy: 'test',
      },
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toContain('not in its allowedTemplateIds');
  });
});

describe('runStackNatsApplyPhase — Phase 3 escape-pattern defense in depth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a role.publish entry that escapes the prefix even if it slipped past validation', async () => {
    // Simulate corrupted DB state: role with `>` that the validator should
    // have caught earlier. Apply must reject defensively rather than emit
    // a permission that shadows the prefix.
    const { stackId } = await seedStack({
      natsRoles: [{ name: 'gateway', publish: ['>'] }],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/escapes the prefix/);
  });

  it('rejects a role.subscribe entry that targets _INBOX.> directly', async () => {
    const { stackId } = await seedStack({
      natsRoles: [{ name: 'gateway', subscribe: ['_INBOX.foo'] }],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toContain('_INBOX');
  });

  it('rejects a corrupt subjectPrefix containing wildcards', async () => {
    const { stackId } = await seedStack({
      natsSubjectPrefix: 'broken.*',
      natsRoles: [{ name: 'gateway', publish: ['x'] }],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toContain('subjectPrefix');
  });
});

describe('runStackNatsApplyPhase — Phase 3 legacy passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('templates using only legacy `nats.credentials` still bind correctly', async () => {
    const accountName = `legacy-acct-${Date.now()}`;
    const credName = `legacy-cred-${Date.now()}`;
    const { stackId, serviceId } = await seedStack({
      natsAccounts: [{ name: accountName, scope: 'host' }],
      natsCredentials: [
        {
          name: credName,
          account: accountName,
          publishAllow: ['legacy.>'],
          subscribeAllow: ['legacy.>'],
          scope: 'host',
        },
      ],
      serviceNatsCredentialRef: credName,
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: 'test-user' });
    expect(result.status).toBe('applied');
    expect(result.servicesBound).toBe(1);

    const svc = await testPrisma.stackService.findUnique({ where: { id: serviceId } });
    expect(svc!.natsCredentialId).not.toBeNull();
    const profile = await testPrisma.natsCredentialProfile.findUnique({
      where: { id: svc!.natsCredentialId! },
    });
    expect(profile!.publishAllow).toEqual(['legacy.>']);
  });

  it('an empty NATS section returns "skipped"', async () => {
    const { stackId } = await seedStack({});
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('skipped');
  });
});

describe('runStackNatsApplyPhase — Phase 3 reviewer-flagged gaps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a service with both natsRole and natsCredentialRef set prefers the role binding', async () => {
    // The Phase 1 validator rejects mixed templates, but the orchestrator
    // also has a defense-in-depth preference: role wins over credentialRef
    // if both are somehow set. This test pins that behavior.
    const accountName = `dual-acct-${Date.now()}`;
    const credName = `dual-cred-${Date.now()}`;
    const { stackId, serviceId } = await seedStack({
      // Both surfaces declared (corrupt-template scenario)
      natsAccounts: [{ name: accountName, scope: 'host' }],
      natsCredentials: [
        {
          name: credName,
          account: accountName,
          publishAllow: ['legacy.>'],
          subscribeAllow: ['legacy.>'],
          scope: 'host',
        },
      ],
      natsRoles: [{ name: 'gateway', publish: ['agent.in'] }],
      serviceNatsRole: 'gateway',
      serviceNatsCredentialRef: credName,
    });

    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');

    const svc = await testPrisma.stackService.findUnique({ where: { id: serviceId } });
    const profile = await testPrisma.natsCredentialProfile.findUnique({
      where: { id: svc!.natsCredentialId! },
    });
    // Role-derived profile wins. Permissions are prefix-prepended, not the
    // bare 'legacy.>' from the legacy credential.
    const pub = profile!.publishAllow as unknown as string[];
    expect(pub.some((s) => s.endsWith('.agent.in'))).toBe(true);
    expect(pub.some((s) => s === 'legacy.>')).toBe(false);
  });

  it('credentialsMapped counts both legacy creds and role-materialized profiles', async () => {
    const { stackId } = await seedStack({
      natsRoles: [
        { name: 'a', publish: ['x'] },
        { name: 'b', publish: ['y'] },
      ],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('applied');
    expect(result.credentialsMapped).toBe(2);
  });

  it('rejects a relative subject containing empty tokens (..) at apply time', async () => {
    const { stackId } = await seedStack({
      natsRoles: [{ name: 'gateway', publish: ['agent..in'] }],
    });
    const result = await runStackNatsApplyPhase(testPrisma, stackId, { triggeredBy: undefined });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/empty tokens/);
  });
});
