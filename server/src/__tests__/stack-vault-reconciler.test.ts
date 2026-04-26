/**
 * Unit tests for stack-vault-reconciler.ts
 *
 * All Vault service calls are mocked via the injected service factories.
 * No real Vault, no real DB (Prisma is mocked per-test).
 *
 * Coverage:
 *  - Happy path: policies → appRoles → KV each applied, snapshot written
 *  - Per-instance scoping: {{stack.id}} resolves to the real stack ID
 *  - Idempotency: same content hash → noop (no writes)
 *  - Partial idempotency: changed policy body → policy write only
 *  - KV path re-validation: injected value with '..' → rejected before write
 *  - fromInput resolution: field value taken from decrypted inputs
 *  - Missing required input → error returned before any Vault call
 *  - Phase failure propagation: policy throws → appRole and KV NOT executed
 *  - AppRole phase failure: appRole throws → KV NOT executed
 *  - KV phase failure: KV write throws → error returned
 *  - Template substitution in policy name + body
 *  - Empty vault section → immediate noop (zero Vault calls)
 *  - lastAppliedVaultSnapshot persisted correctly
 *  - lastFailureReason cleared on success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the UserEventService so the unit test doesn't need a real DB/prisma.
vi.mock('../services/user-events/user-event-service', () => {
  class UserEventService {
    createEvent = vi.fn().mockResolvedValue({});
  }
  return { UserEventService };
});

import { runStackVaultReconciler } from '../services/stacks/stack-vault-reconciler';
import type { PolicyServiceFacade, AppRoleServiceFacade, KVServiceFacade } from '../services/stacks/stack-vault-reconciler';
import { encryptInputValues } from '../services/stacks/stack-input-values-service';
import type { TemplateInputDeclaration, TemplateVaultPolicy, TemplateVaultAppRole, TemplateVaultKv } from '@mini-infra/types';
import type { PrismaClient } from '../lib/prisma';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decl(name: string, opts: Partial<TemplateInputDeclaration> = {}): TemplateInputDeclaration {
  return { name, sensitive: true, required: true, rotateOnUpgrade: false, ...opts };
}

function makePolicy(overrides: Partial<TemplateVaultPolicy> = {}): TemplateVaultPolicy {
  return {
    name: 'my-policy',
    body: 'path "secret/*" { capabilities = ["read"] }',
    scope: 'stack',
    ...overrides,
  };
}

function makeAppRole(overrides: Partial<TemplateVaultAppRole> = {}): TemplateVaultAppRole {
  return {
    name: 'my-approle',
    policy: 'my-policy',
    scope: 'stack',
    ...overrides,
  };
}

function makeKv(overrides: Partial<TemplateVaultKv> = {}): TemplateVaultKv {
  return {
    path: 'stacks/mystack/config',
    fields: { token: { value: 'literal-value' } },
    ...overrides,
  };
}

/** Build a minimal Prisma mock that satisfies what runStackVaultReconciler needs. */
function makePrisma(opts: {
  encryptedInputValues?: string;
  lastAppliedVaultSnapshot?: Record<string, unknown> | null;
  environmentId?: string | null;
  lastFailureReason?: string | null;
} = {}): PrismaClient {
  const stackRow = {
    encryptedInputValues: opts.encryptedInputValues ?? null,
    lastAppliedVaultSnapshot: opts.lastAppliedVaultSnapshot ?? null,
    name: 'teststack',
    environmentId: opts.environmentId ?? null,
    networks: [],
    volumes: [],
    parameterValues: null,
    parameters: null,
    lastFailureReason: opts.lastFailureReason ?? null,
  };

  const updateMock = vi.fn().mockResolvedValue({ ...stackRow });

  return {
    stack: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(stackRow),
      update: updateMock,
    },
    environment: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaClient;
}

function makePolicySvc(opts: { existing?: { id: string; displayName: string } | null; throwOnCreate?: boolean; throwOnPublish?: boolean } = {}): PolicyServiceFacade {
  const existing = opts.existing !== undefined ? opts.existing : null;
  return {
    getByName: vi.fn().mockResolvedValue(existing),
    create: opts.throwOnCreate
      ? vi.fn().mockRejectedValue(new Error('policy create failed'))
      : vi.fn().mockResolvedValue({ id: 'pol-1', displayName: 'test policy' }),
    update: vi.fn().mockResolvedValue({ id: existing?.id ?? 'pol-1', displayName: 'test policy' }),
    publish: opts.throwOnPublish
      ? vi.fn().mockRejectedValue(new Error('policy publish failed'))
      : vi.fn().mockResolvedValue({ id: existing?.id ?? 'pol-1' }),
  };
}

function makeAppRoleSvc(opts: { existing?: { id: string } | null; throwOnCreate?: boolean; throwOnApply?: boolean } = {}): AppRoleServiceFacade {
  const existing = opts.existing !== undefined ? opts.existing : null;
  return {
    getByName: vi.fn().mockResolvedValue(existing),
    create: opts.throwOnCreate
      ? vi.fn().mockRejectedValue(new Error('approle create failed'))
      : vi.fn().mockResolvedValue({ id: 'ar-1' }),
    update: vi.fn().mockResolvedValue({ id: existing?.id ?? 'ar-1' }),
    apply: opts.throwOnApply
      ? vi.fn().mockRejectedValue(new Error('approle apply failed'))
      : vi.fn().mockResolvedValue({ id: existing?.id ?? 'ar-1' }),
  };
}

function makeKVSvc(opts: { throwOnWrite?: boolean } = {}): KVServiceFacade {
  return {
    write: opts.throwOnWrite
      ? vi.fn().mockRejectedValue(new Error('kv write failed'))
      : vi.fn().mockResolvedValue(undefined),
  };
}

function makeServices(overrides: {
  policy?: PolicyServiceFacade;
  appRole?: AppRoleServiceFacade;
  kv?: KVServiceFacade;
} = {}) {
  return {
    getPolicyService: vi.fn().mockResolvedValue(overrides.policy ?? makePolicySvc()),
    getAppRoleService: vi.fn().mockResolvedValue(overrides.appRole ?? makeAppRoleSvc()),
    getKVService: vi.fn().mockResolvedValue(overrides.kv ?? makeKVSvc()),
  };
}

const BASE_STACK_ID = 'stack-abc123';
const BASE_TEMPLATE_VERSION = 1;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runStackVaultReconciler', () => {

  describe('empty vault section', () => {
    it('returns noop immediately when vault section is empty', async () => {
      const prisma = makePrisma();
      const svcs = makeServices();

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {},
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('noop');
      expect(result.appliedAppRoleIdByName).toEqual({});
      expect(svcs.getPolicyService).not.toHaveBeenCalled();
      expect(svcs.getAppRoleService).not.toHaveBeenCalled();
      expect(svcs.getKVService).not.toHaveBeenCalled();
    });
  });

  describe('missing required inputs', () => {
    it('returns error when required input has no stored value', async () => {
      const prisma = makePrisma({ encryptedInputValues: undefined });
      const svcs = makeServices();

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [decl('botToken', { required: true })],
        vault: { policies: [makePolicy()] },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/botToken/);
      expect(svcs.getPolicyService).not.toHaveBeenCalled();
    });

    it('passes when required input has a stored value', async () => {
      const encrypted = encryptInputValues({ botToken: 'xoxb-1234' });
      const prisma = makePrisma({ encryptedInputValues: encrypted });
      const svcs = makeServices();

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [decl('botToken', { required: true })],
        vault: { policies: [makePolicy()] },
        userId: 'user-1',
      }, svcs);

      expect(result.status).not.toBe('error');
    });

    it('ignores rotateOnUpgrade inputs for the required-check', async () => {
      // rotateOnUpgrade values are expected to be supplied fresh — they
      // may not be in the stored blob and that is OK at this phase.
      const encrypted = encryptInputValues({ staticVal: 'kept' });
      const prisma = makePrisma({ encryptedInputValues: encrypted });
      const svcs = makeServices();

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [
          decl('staticVal', { required: true, rotateOnUpgrade: false }),
          decl('rotatedSecret', { required: true, rotateOnUpgrade: true }),
        ],
        vault: { policies: [makePolicy()] },
        userId: 'user-1',
      }, svcs);

      // rotateOnUpgrade missing from stored is not an error at vault-reconcile time
      expect(result.status).not.toBe('error');
    });
  });

  describe('policy phase', () => {
    it('upserts and publishes a new policy', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const svcs = makeServices({ policy: polSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: { policies: [makePolicy()] },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('applied');
      expect(polSvc.create).toHaveBeenCalledOnce();
      expect(polSvc.publish).toHaveBeenCalledOnce();
    });

    it('skips write when content hash matches previous snapshot', async () => {
      // Build the same hash that the reconciler would compute for this policy
      const policy = makePolicy({ name: 'my-policy', body: 'path "secret/*" { capabilities = ["read"] }' });
      const concreteName = 'my-policy'; // no template tokens
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update(concreteName + '\n' + policy.body).digest('hex');

      const snapshot = {
        policies: { hashes: { [concreteName]: hash } },
        appRoles: { hashes: {} },
        kv: { hashes: {} },
      };

      const prisma = makePrisma({ lastAppliedVaultSnapshot: snapshot });
      const polSvc = makePolicySvc({ existing: { id: 'pol-existing', displayName: 'existing' } });
      const svcs = makeServices({ policy: polSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: { policies: [policy] },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('noop');
      expect(polSvc.create).not.toHaveBeenCalled();
      expect(polSvc.publish).not.toHaveBeenCalled();
    });

    it('applies when content hash differs from previous snapshot', async () => {
      const policy = makePolicy();
      const snapshot = {
        policies: { hashes: { 'my-policy': 'old-hash-different' } },
        appRoles: { hashes: {} },
        kv: { hashes: {} },
      };

      const prisma = makePrisma({ lastAppliedVaultSnapshot: snapshot });
      const polSvc = makePolicySvc({ existing: null });
      const svcs = makeServices({ policy: polSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: { policies: [policy] },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('applied');
      expect(polSvc.create).toHaveBeenCalledOnce();
    });

    it('returns error when policy create throws; does not proceed to appRole phase', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ throwOnCreate: true });
      const arSvc = makeAppRoleSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'pol-a' })],
          appRoles: [makeAppRole()],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/policy create failed/);
      expect(arSvc.create).not.toHaveBeenCalled();
    });

    it('renders {{stack.id}} in policy name to concrete stack ID', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const svcs = makeServices({ policy: polSvc });

      await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: { policies: [makePolicy({ name: 'policy-{{stack.id}}' })] },
        userId: 'user-1',
      }, svcs);

      const createArg = (polSvc.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { name: string };
      expect(createArg.name).toBe(`policy-${BASE_STACK_ID}`);
    });

    it('renders {{stack.id}} in policy body', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const svcs = makeServices({ policy: polSvc });

      await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: { policies: [makePolicy({ body: 'path "stacks/{{stack.id}}/*" { capabilities = ["read"] }' })] },
        userId: 'user-1',
      }, svcs);

      const createArg = (polSvc.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { draftHclBody: string };
      expect(createArg.draftHclBody).toContain(BASE_STACK_ID);
    });
  });

  describe('appRole phase', () => {
    it('creates and applies an AppRole after the policy phase', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const svcs = makeServices({ policy: polSvc, appRole: arSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('applied');
      expect(arSvc.create).toHaveBeenCalledOnce();
      expect(arSvc.apply).toHaveBeenCalledOnce();
      expect(result.appliedAppRoleIdByName['my-approle']).toBe('ar-1');
    });

    it('returns error when AppRole apply throws; KV phase not executed', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ throwOnApply: true });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
          kv: [makeKv()],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/approle apply failed/);
      expect(kvSvc.write).not.toHaveBeenCalled();
    });

    it('renders {{stack.id}} in AppRole name', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const svcs = makeServices({ policy: polSvc, appRole: arSvc });

      await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'ar-{{stack.id}}', policy: 'my-policy' })],
        },
        userId: 'user-1',
      }, svcs);

      const createArg = (arSvc.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { name: string };
      expect(createArg.name).toBe(`ar-${BASE_STACK_ID}`);
    });

    it('uses existing AppRole record when found by name', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: { id: 'ar-existing' } });
      const svcs = makeServices({ policy: polSvc, appRole: arSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
        },
        userId: 'user-1',
      }, svcs);

      expect(arSvc.create).not.toHaveBeenCalled();
      expect(arSvc.update).toHaveBeenCalledOnce();
      expect(result.appliedAppRoleIdByName['my-approle']).toBe('ar-existing');
    });
  });

  describe('KV phase', () => {
    it('writes KV entry with literal field value', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
          kv: [makeKv({ path: 'stacks/test/config', fields: { key: { value: 'literal' } } })],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('applied');
      expect(kvSvc.write).toHaveBeenCalledWith('stacks/test/config', { key: 'literal' });
    });

    it('resolves fromInput field to decrypted input value', async () => {
      const encrypted = encryptInputValues({ myToken: 'secret-token-value' });
      const prisma = makePrisma({ encryptedInputValues: encrypted });
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [decl('myToken', { required: true })],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
          kv: [makeKv({ path: 'stacks/test/creds', fields: { token: { fromInput: 'myToken' } } })],
        },
        userId: 'user-1',
      }, svcs);

      expect(kvSvc.write).toHaveBeenCalledWith('stacks/test/creds', { token: 'secret-token-value' });
    });

    it('rejects a KV path containing ".." after substitution', async () => {
      const encrypted = encryptInputValues({ evilInput: '../etc/passwd' });
      const prisma = makePrisma({ encryptedInputValues: encrypted });
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [decl('evilInput')],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
          kv: [makeKv({ path: 'stacks/{{inputs.evilInput}}/config', fields: { k: { value: 'v' } } })],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/invalid/i);
      expect(kvSvc.write).not.toHaveBeenCalled();
    });

    it('skips KV write when content hash matches snapshot', async () => {
      const path = 'stacks/test/config';
      const fields = { key: 'literal' };
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update(path + '\n' + JSON.stringify(fields)).digest('hex');

      const snapshot = {
        policies: { hashes: {} },
        appRoles: { hashes: {} },
        kv: { hashes: { [path]: hash } },
      };

      const prisma = makePrisma({ lastAppliedVaultSnapshot: snapshot });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ kv: kvSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          kv: [makeKv({ path, fields: { key: { value: 'literal' } } })],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('noop');
      expect(kvSvc.write).not.toHaveBeenCalled();
    });

    it('returns error and marks stack when KV write fails', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const kvSvc = makeKVSvc({ throwOnWrite: true });
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
          kv: [makeKv()],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/kv write failed/);
    });

    it('renders {{stack.id}} in KV path', async () => {
      const prisma = makePrisma();
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
          kv: [makeKv({ path: 'stacks/{{stack.id}}/config', fields: { k: { value: 'v' } } })],
        },
        userId: 'user-1',
      }, svcs);

      expect(kvSvc.write).toHaveBeenCalledWith(`stacks/${BASE_STACK_ID}/config`, { k: 'v' });
    });
  });

  describe('snapshot and state management', () => {
    it('persists lastAppliedVaultSnapshot after successful apply', async () => {
      const prisma = makePrisma();
      const svcs = makeServices({
        policy: makePolicySvc({ existing: null }),
        appRole: makeAppRoleSvc({ existing: null }),
        kv: makeKVSvc(),
      });

      await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: {
          policies: [makePolicy({ name: 'my-policy' })],
          appRoles: [makeAppRole({ name: 'my-approle', policy: 'my-policy' })],
          kv: [makeKv({ path: 'stacks/test/config', fields: { k: { value: 'v' } } })],
        },
        userId: 'user-1',
      }, svcs);

      const updateCalls = (prisma.stack.update as ReturnType<typeof vi.fn>).mock.calls;
      expect(updateCalls.length).toBeGreaterThan(0);
      const updateData = updateCalls[updateCalls.length - 1][0].data;
      expect(updateData.lastAppliedVaultSnapshot).toBeDefined();
      const snap = updateData.lastAppliedVaultSnapshot as Record<string, unknown>;
      expect(snap).toHaveProperty('policies');
      expect(snap).toHaveProperty('appRoles');
      expect(snap).toHaveProperty('kv');
    });

    it('clears lastFailureReason on successful apply', async () => {
      const prisma = makePrisma({ lastFailureReason: 'previous error' });
      const svcs = makeServices({
        policy: makePolicySvc({ existing: null }),
      });

      await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: BASE_TEMPLATE_VERSION,
        inputs: [],
        vault: { policies: [makePolicy({ name: 'my-policy' })] },
        userId: 'user-1',
      }, svcs);

      const updateCalls = (prisma.stack.update as ReturnType<typeof vi.fn>).mock.calls;
      const lastUpdate = updateCalls[updateCalls.length - 1][0].data;
      expect(lastUpdate.lastFailureReason).toBeNull();
    });
  });

  describe('full happy path', () => {
    it('runs all three phases and returns applied with appRoleIdByName populated', async () => {
      const encrypted = encryptInputValues({ slackToken: 'xoxb-real' });
      const prisma = makePrisma({ encryptedInputValues: encrypted });
      const polSvc = makePolicySvc({ existing: null });
      const arSvc = makeAppRoleSvc({ existing: null });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      const result = await runStackVaultReconciler(prisma, BASE_STACK_ID, {
        stackId: BASE_STACK_ID,
        templateVersion: 3,
        inputs: [decl('slackToken')],
        vault: {
          policies: [makePolicy({ name: 'slackbot-{{stack.id}}', body: 'path "secret/slackbot/*" { capabilities = ["read"] }' })],
          appRoles: [makeAppRole({ name: 'slackbot-ar-{{stack.id}}', policy: 'slackbot-{{stack.id}}' })],
          kv: [makeKv({ path: `stacks/${BASE_STACK_ID}/slackbot`, fields: { token: { fromInput: 'slackToken' } } })],
        },
        userId: 'user-1',
      }, svcs);

      expect(result.status).toBe('applied');
      expect(result.appliedAppRoleIdByName['slackbot-ar-{{stack.id}}']).toBe('ar-1');
      expect(kvSvc.write).toHaveBeenCalledWith(`stacks/${BASE_STACK_ID}/slackbot`, { token: 'xoxb-real' });
      expect(polSvc.create).toHaveBeenCalledOnce();
      expect(arSvc.create).toHaveBeenCalledOnce();
    });
  });
});
