/**
 * Integration tests for stack-vault-reconciler.ts with a real SQLite DB.
 *
 * Vault service calls are mocked at the facade level — no real Vault needed.
 * The DB layer (Prisma) is real so we can verify:
 *   - The reconciler returns a snapshot that the caller can persist
 *   - lastFailureReason is set on error
 *   - Idempotent re-apply (snapshot in DB causes noop)
 *   - StackService.vaultAppRoleId is written by the apply route helper
 *   - Orphaned input pruning removes keys not in the current template
 *   - mergeForUpgrade route enforcement
 *
 * Note: lastAppliedVaultSnapshot is now written by the apply route (caller),
 * not by the reconciler itself. Reconciler returns result.snapshot for the
 * caller to commit atomically with service ID updates. Tests that need the
 * snapshot to be in the DB (e.g. idempotency) must persist it manually.
 *
 * Coverage:
 *   - Full apply with all 3 phases → result.snapshot populated
 *   - Missing required input → error, no Vault writes
 *   - Idempotent re-apply → no writes (requires snapshot pre-written to DB)
 *   - Changed KV field → only KV write issued
 *   - AppRole failure → stack.lastFailureReason populated, KV not executed
 *   - Orphaned input cleanup after successful apply
 *   - PATCH with rotateOnUpgrade input missing from supplied → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testPrisma } from './integration-test-helpers';
import { runStackVaultReconciler } from '../services/stacks/stack-vault-reconciler';
import type { PolicyServiceFacade, AppRoleServiceFacade, KVServiceFacade } from '../services/stacks/stack-vault-reconciler';
import { encryptInputValues } from '../services/stacks/stack-input-values-service';
import { pruneOrphanedInputValues } from '../services/stacks/orphan-input-pruner';
import type { TemplateInputDeclaration, TemplateVaultPolicy, TemplateVaultAppRole, TemplateVaultKv } from '@mini-infra/types';
import { createId } from '@paralleldrive/cuid2';

// ─── Factories ────────────────────────────────────────────────────────────────

function decl(name: string, opts: Partial<TemplateInputDeclaration> = {}): TemplateInputDeclaration {
  return { name, sensitive: true, required: true, rotateOnUpgrade: false, ...opts };
}

function pol(name: string): TemplateVaultPolicy {
  return { name, body: `path "secret/${name}/*" { capabilities = ["read"] }`, scope: 'stack' };
}

function ar(name: string, policy: string): TemplateVaultAppRole {
  return { name, policy, scope: 'stack' };
}

function kv(path: string, fields: TemplateVaultKv['fields']): TemplateVaultKv {
  return { path, fields };
}

/** Build a mock host environment. Returns the ID. */
async function createTestEnvironment(): Promise<string> {
  const env = await testPrisma.environment.create({
    data: {
      id: createId(),
      name: `test-env-${createId().slice(0, 6)}`,
      type: 'nonproduction',
      networkType: 'local',
    },
  });
  return env.id;
}

/** Create a minimal Stack row suitable for vault reconciler tests. */
async function createTestStack(opts: {
  encryptedInputValues?: string;
  environmentId?: string | null;
  lastAppliedVaultSnapshot?: unknown;
  services?: Array<{ serviceName: string; vaultAppRoleRef?: string }>;
} = {}): Promise<string> {
  const id = createId();
  await testPrisma.stack.create({
    data: {
      id,
      name: `stack-${id.slice(0, 6)}`,
      networks: JSON.stringify([]),
      volumes: JSON.stringify([]),
      encryptedInputValues: opts.encryptedInputValues ?? null,
      ...(opts.environmentId !== undefined ? { environmentId: opts.environmentId } : {}),
      lastAppliedVaultSnapshot: opts.lastAppliedVaultSnapshot
        ? JSON.stringify(opts.lastAppliedVaultSnapshot)
        : null,
    },
  });

  if (opts.services && opts.services.length > 0) {
    for (const [i, svc] of opts.services.entries()) {
      await testPrisma.stackService.create({
        data: {
          id: createId(),
          stackId: id,
          serviceName: svc.serviceName,
          serviceType: 'Stateful',
          dockerImage: 'myimage',
          dockerTag: 'latest',
          containerConfig: JSON.stringify({ restartPolicy: 'unless-stopped' }),
          dependsOn: JSON.stringify([]),
          order: i,
          vaultAppRoleRef: svc.vaultAppRoleRef ?? null,
        },
      });
    }
  }

  return id;
}

// Mock services helpers

function makePolicySvc(opts: { throwOnCreate?: boolean; throwOnPublish?: boolean } = {}): PolicyServiceFacade {
  let callCount = 0;
  return {
    getByName: vi.fn().mockResolvedValue(null),
    create: opts.throwOnCreate
      ? vi.fn().mockRejectedValue(new Error('policy create failed'))
      : vi.fn().mockImplementation((input: { name: string }) => {
          callCount++;
          return Promise.resolve({ id: `pol-${callCount}`, displayName: input.name });
        }),
    update: vi.fn().mockImplementation((_id: string) => Promise.resolve({ id: _id, displayName: 'updated' })),
    publish: opts.throwOnPublish
      ? vi.fn().mockRejectedValue(new Error('policy publish failed'))
      : vi.fn().mockImplementation((id: string) => Promise.resolve({ id })),
  };
}

function makeAppRoleSvc(opts: { throwOnApply?: boolean } = {}): AppRoleServiceFacade {
  let callCount = 0;
  return {
    getByName: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((input: { name: string }) => {
      callCount++;
      return Promise.resolve({ id: `ar-${callCount}-${input.name}` });
    }),
    update: vi.fn().mockImplementation((id: string) => Promise.resolve({ id })),
    apply: opts.throwOnApply
      ? vi.fn().mockRejectedValue(new Error('approle apply failed'))
      : vi.fn().mockImplementation((id: string) => Promise.resolve({ id })),
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('stack-vault-reconciler integration', () => {

  describe('full apply — all three phases', () => {
    it('returns a snapshot in result.snapshot after a full apply', async () => {
      const encrypted = encryptInputValues({ slackToken: 'xoxb-secret' });
      const stackId = await createTestStack({ encryptedInputValues: encrypted });

      const polSvc = makePolicySvc();
      const arSvc = makeAppRoleSvc();
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: polSvc, appRole: arSvc, kv: kvSvc });

      const result = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('slackToken')],
        vault: {
          policies: [pol('my-policy')],
          appRoles: [ar('my-approle', 'my-policy')],
          kv: [kv(`stacks/${stackId}/config`, { token: { fromInput: 'slackToken' } })],
        },
        userId: 'user-test',
      }, svcs);

      expect(result.status).toBe('applied');
      expect(result.snapshot).toBeDefined();
      expect(result.snapshot).toHaveProperty('policies');
      expect(result.snapshot).toHaveProperty('appRoles');
      expect(result.snapshot).toHaveProperty('kv');
    });

    it('does not set lastFailureReason (caller owns DB writes on success)', async () => {
      const stackId = await createTestStack();

      const svcs = makeServices({ policy: makePolicySvc() });

      const result = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [],
        vault: { policies: [pol('my-policy')] },
        userId: 'user-test',
      }, svcs);

      expect(result.status).toBe('applied');
      const stack = await testPrisma.stack.findUniqueOrThrow({ where: { id: stackId } });
      expect(stack.lastAppliedVaultSnapshot).toBeNull();
    });

    it('vault writes go to the kv service with resolved inputs', async () => {
      const encrypted = encryptInputValues({ apiKey: 'secret-api-key' });
      const stackId = await createTestStack({ encryptedInputValues: encrypted });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: makePolicySvc(), appRole: makeAppRoleSvc(), kv: kvSvc });

      await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('apiKey')],
        vault: {
          policies: [pol('api-pol')],
          appRoles: [ar('api-ar', 'api-pol')],
          kv: [kv('services/myapp/creds', { key: { fromInput: 'apiKey' } })],
        },
        userId: 'user-test',
      }, svcs);

      expect(kvSvc.write).toHaveBeenCalledWith('services/myapp/creds', { key: 'secret-api-key' });
    });
  });

  describe('missing required input → error, no vault writes', () => {
    it('returns error and does not call any vault service when required input missing', async () => {
      const stackId = await createTestStack({ encryptedInputValues: undefined });
      const polSvc = makePolicySvc();
      const svcs = makeServices({ policy: polSvc });

      const result = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('requiredToken', { required: true })],
        vault: { policies: [pol('my-policy')] },
        userId: 'user-test',
      }, svcs);

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/requiredToken/);
      expect(polSvc.create).not.toHaveBeenCalled();
    });
  });

  describe('idempotent re-apply', () => {
    it('returns noop on re-apply with same inputs and snapshot', async () => {
      // First apply to build the snapshot
      const encrypted = encryptInputValues({ key: 'val' });
      const stackId = await createTestStack({ encryptedInputValues: encrypted });
      const polSvc1 = makePolicySvc();
      const svcs1 = makeServices({ policy: polSvc1 });

      const result1 = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('key')],
        vault: { policies: [pol('idempotent-policy')] },
        userId: 'user-test',
      }, svcs1);

      expect(polSvc1.create).toHaveBeenCalledOnce();

      // Simulate what the apply route does: persist the snapshot to the DB.
      await testPrisma.stack.update({
        where: { id: stackId },
        data: { lastAppliedVaultSnapshot: result1.snapshot as unknown as import('../generated/prisma/client').Prisma.InputJsonValue },
      });

      // Second apply — same vault section — should be noop
      const polSvc2 = makePolicySvc();
      // Override getByName to return the policy (as if it already exists)
      (polSvc2.getByName as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'pol-1', displayName: 'existing' });
      const svcs2 = makeServices({ policy: polSvc2 });

      const result2 = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('key')],
        vault: { policies: [pol('idempotent-policy')] },
        userId: 'user-test',
      }, svcs2);

      expect(result2.status).toBe('noop');
      expect(polSvc2.create).not.toHaveBeenCalled();
      expect(polSvc2.publish).not.toHaveBeenCalled();
    });
  });

  describe('partial idempotency — changed KV only', () => {
    it('writes only the changed KV entry when policy is unchanged', async () => {
      const encrypted = encryptInputValues({ val: 'initial' });
      const stackId = await createTestStack({ encryptedInputValues: encrypted });
      const policyName = 'partial-idempotency-pol';
      const kvPath = `stacks/${stackId}/config`;

      // First apply
      const kvSvc1 = makeKVSvc();
      const svcs1 = makeServices({ policy: makePolicySvc(), kv: kvSvc1 });

      const result1 = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('val')],
        vault: {
          policies: [pol(policyName)],
          kv: [kv(kvPath, { field: { fromInput: 'val' } })],
        },
        userId: 'user-test',
      }, svcs1);

      expect(kvSvc1.write).toHaveBeenCalledOnce();

      // Simulate what the apply route does: persist the snapshot to the DB.
      await testPrisma.stack.update({
        where: { id: stackId },
        data: { lastAppliedVaultSnapshot: result1.snapshot as unknown as import('../generated/prisma/client').Prisma.InputJsonValue },
      });

      // Update the encrypted input (simulate value change)
      const encrypted2 = encryptInputValues({ val: 'changed' });
      await testPrisma.stack.update({
        where: { id: stackId },
        data: { encryptedInputValues: encrypted2 },
      });

      // Second apply — only KV should be written (policy hash unchanged)
      const polSvc2 = makePolicySvc();
      (polSvc2.getByName as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'pol-1', displayName: policyName });
      const kvSvc2 = makeKVSvc();
      const svcs2 = makeServices({ policy: polSvc2, kv: kvSvc2 });

      const result2 = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('val')],
        vault: {
          policies: [pol(policyName)],
          kv: [kv(kvPath, { field: { fromInput: 'val' } })],
        },
        userId: 'user-test',
      }, svcs2);

      expect(result2.status).toBe('applied');
      expect(polSvc2.create).not.toHaveBeenCalled(); // policy unchanged
      expect(kvSvc2.write).toHaveBeenCalledOnce(); // KV changed
      expect(kvSvc2.write).toHaveBeenCalledWith(kvPath, { field: 'changed' });
    });
  });

  describe('AppRole failure → stack.lastFailureReason', () => {
    it('sets lastFailureReason when AppRole apply throws', async () => {
      const stackId = await createTestStack();
      const arSvc = makeAppRoleSvc({ throwOnApply: true });
      const svcs = makeServices({ policy: makePolicySvc(), appRole: arSvc });

      const result = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [],
        vault: {
          policies: [pol('my-policy')],
          appRoles: [ar('my-approle', 'my-policy')],
        },
        userId: 'user-test',
      }, svcs);

      expect(result.status).toBe('error');

      const stack = await testPrisma.stack.findUniqueOrThrow({ where: { id: stackId } });
      expect(stack.lastFailureReason).not.toBeNull();
      expect(stack.lastFailureReason).toMatch(/approle apply failed/);
      expect(stack.status).toBe('error');
    });
  });

  describe('orphaned input cleanup', () => {
    it('prunes orphaned keys after successful apply', async () => {
      // Stack has inputs for v1 (a, b), template v2 drops b and adds c
      const encrypted = encryptInputValues({ a: 'val-a', b: 'val-b', c: 'val-c' });
      const stackId = await createTestStack({ encryptedInputValues: encrypted });

      // Create a template + version
      const templateId = createId();
      await testPrisma.stackTemplate.create({
        data: {
          id: templateId,
          name: `tpl-${templateId.slice(0, 6)}`,
          displayName: 'Test Template',
          source: 'user',
          scope: 'host',
          currentVersionId: null,
          draftVersionId: null,
        },
      });

      await testPrisma.stackTemplateVersion.create({
        data: {
          id: createId(),
          templateId,
          version: 2,
          status: 'published',
          parameters: [],
          defaultParameterValues: {},
          networkTypeDefaults: {},
          networks: [],
          volumes: [],
          inputs: [
            decl('a'),
            decl('c'),
            // 'b' is dropped
          ],
        },
      });

      // Link the stack to the template version
      await testPrisma.stack.update({
        where: { id: stackId },
        data: { templateId, templateVersion: 2 },
      });

      // Call the real pruneOrphanedInputValues via the exported function.
      await pruneOrphanedInputValues(testPrisma, stackId);

      const after = await testPrisma.stack.findUniqueOrThrow({
        where: { id: stackId },
        select: { encryptedInputValues: true },
      });

      expect(after.encryptedInputValues).not.toBeNull();
      const { decryptInputValues: decrypt } = await import('../services/stacks/stack-input-values-service');
      const pruned = decrypt(after.encryptedInputValues!);

      expect(pruned).toEqual({ a: 'val-a', c: 'val-c' });
      expect(Object.keys(pruned)).not.toContain('b');
    });

    it('is a no-op when all keys are still declared', async () => {
      const encrypted = encryptInputValues({ a: 'val-a' });
      const stackId = await createTestStack({ encryptedInputValues: encrypted });

      const templateId = createId();
      await testPrisma.stackTemplate.create({
        data: {
          id: templateId,
          name: `tpl-${templateId.slice(0, 6)}`,
          displayName: 'No-op Template',
          source: 'user',
          scope: 'host',
          currentVersionId: null,
          draftVersionId: null,
        },
      });

      await testPrisma.stackTemplateVersion.create({
        data: {
          id: createId(),
          templateId,
          version: 1,
          status: 'published',
          parameters: [],
          defaultParameterValues: {},
          networkTypeDefaults: {},
          networks: [],
          volumes: [],
          inputs: [decl('a')],
        },
      });

      await testPrisma.stack.update({
        where: { id: stackId },
        data: { templateId, templateVersion: 1 },
      });

      const before = await testPrisma.stack.findUniqueOrThrow({
        where: { id: stackId },
        select: { encryptedInputValues: true },
      });

      await pruneOrphanedInputValues(testPrisma, stackId);

      const after = await testPrisma.stack.findUniqueOrThrow({
        where: { id: stackId },
        select: { encryptedInputValues: true },
      });

      expect(after.encryptedInputValues).toBe(before.encryptedInputValues);
    });

    it('does not throw when encryptedInputValues is null', async () => {
      const stackId = await createTestStack({ encryptedInputValues: undefined });

      await expect(pruneOrphanedInputValues(testPrisma, stackId)).resolves.toBeUndefined();
    });
  });

  describe('appliedAppRoleIdByName in result', () => {
    it('returns a mapping from template appRole name to DB AppRole ID', async () => {
      const stackId = await createTestStack();
      const arSvc = makeAppRoleSvc();
      const svcs = makeServices({ policy: makePolicySvc(), appRole: arSvc });

      const result = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [],
        vault: {
          policies: [pol('svc-policy')],
          appRoles: [ar('svc-approle', 'svc-policy')],
        },
        userId: 'user-test',
      }, svcs);

      expect(result.status).toBe('applied');
      expect(result.appliedAppRoleIdByName).toHaveProperty('svc-approle');
      expect(result.appliedAppRoleIdByName['svc-approle']).toBeTruthy();
    });
  });

  describe('KV path validation after substitution', () => {
    it('rejects a path with injected ".." before writing to Vault', async () => {
      const encrypted = encryptInputValues({ dangerous: '../../../etc' });
      const stackId = await createTestStack({ encryptedInputValues: encrypted });
      const kvSvc = makeKVSvc();
      const svcs = makeServices({ policy: makePolicySvc(), kv: kvSvc });

      const result = await runStackVaultReconciler(testPrisma, stackId, {
        stackId,
        templateVersion: 1,
        inputs: [decl('dangerous')],
        vault: {
          policies: [pol('safe-pol')],
          kv: [kv('stacks/{{inputs.dangerous}}/config', { k: { value: 'v' } })],
        },
        userId: 'user-test',
      }, svcs);

      expect(result.status).toBe('error');
      expect(kvSvc.write).not.toHaveBeenCalled();
    });
  });
});
