/**
 * Route-level regression test for the vault phase of POST /api/stacks/:id/apply.
 *
 * Critical regression this file guards:
 *   The apply route formerly read `vaultAppRoleRef` from `StackService` rows
 *   (table: stack_services) which doesn't have that column. Prisma threw a
 *   PrismaClientValidationError on every apply of a template-bound stack.
 *   The fix reads vaultAppRoleRef from StackTemplateServiceDefinition
 *   (table: stack_template_services) and joins on serviceName.
 *
 * These tests send a real HTTP request through the route (via supertest) and
 * let runVaultPhaseIfNeeded execute against the integration test DB so Prisma
 * query validation is exercised.  Vault service calls and the container
 * reconciler are mocked at the facade level — no real Vault or Docker needed.
 */

import supertest from 'supertest';
import express from 'express';
import { vi, describe, it, expect } from 'vitest';
import { testPrisma } from './integration-test-helpers';
import { createId } from '@paralleldrive/cuid2';
import { encryptInputValues } from '../services/stacks/stack-input-values-service';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockPlan, mockApply, MOCK_AR_ID } = vi.hoisted(() => {
  const mockPlan = vi.fn().mockResolvedValue({
    stackId: 'ignored',
    stackName: 'test',
    stackVersion: 1,
    planTime: new Date().toISOString(),
    actions: [],
    resourceActions: [],
    hasChanges: false,
  });

  const mockApply = vi.fn().mockResolvedValue({
    success: true,
    stackId: 'ignored',
    appliedVersion: 1,
    serviceResults: [],
    resourceResults: [],
    duration: 0,
  });

  // Stable ID used in the mock — must match VaultAppRole record created in test setup.
  const MOCK_AR_ID = 'ar-test-mock-fixed-id';

  return { mockPlan, mockApply, MOCK_AR_ID };
});

vi.mock('../services/stacks/stack-operation-context', () => ({
  buildStackOperationServices: vi.fn().mockResolvedValue({
    reconciler: {
      plan: mockPlan,
      apply: mockApply,
    },
  }),
}));

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: 'test-user' };
    next();
  },
}));

vi.mock('../services/vault/vault-services', () => ({
  vaultServicesReady: vi.fn().mockReturnValue(true),
  getVaultServices: vi.fn().mockReturnValue({ admin: {} }),
}));

vi.mock('../services/stacks/stack-vault-reconciler', () => ({
  runStackVaultReconciler: vi.fn().mockResolvedValue({
    status: 'applied' as const,
    appliedAppRoleIdByName: { 'my-approle': MOCK_AR_ID },
    // encryptedSnapshot is a String? now — use a dummy base64 blob for tests.
    encryptedSnapshot: Buffer.from(JSON.stringify({ version: 2, policies: {}, appRoles: {}, kv: {} })).toString('base64'),
  }),
}));

vi.mock('../services/stacks/stack-socket-emitter', () => ({
  emitStackApplyStarted: vi.fn(),
  emitStackApplyServiceResult: vi.fn(),
  emitStackApplyCompleted: vi.fn(),
  emitStackApplyFailed: vi.fn(),
}));

vi.mock('../services/stacks/stack-user-event', () => {
  class StackUserEvent {
    begin = vi.fn().mockResolvedValue(undefined);
    appendLogs = vi.fn().mockResolvedValue(undefined);
    updateProgress = vi.fn().mockResolvedValue(undefined);
    update = vi.fn().mockResolvedValue(undefined);
    fail = vi.fn().mockResolvedValue(undefined);
  }
  return { StackUserEvent };
});

vi.mock('../lib/prisma', () => ({ default: testPrisma }));

vi.mock('../services/haproxy/haproxy-post-apply', () => ({
  restoreHAProxyRuntimeState: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../services/monitoring', () => ({
  MonitoringService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    ensureAppConnectedToMonitoringNetwork: vi.fn().mockResolvedValue(undefined),
  })),
}));

import stacksApplyRoute from '../routes/stacks/stacks-apply-route';
import { stackOperationLock } from '../services/stacks/operation-lock';
import { runStackVaultReconciler } from '../services/stacks/stack-vault-reconciler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stacks', stacksApplyRoute);
  return app;
}

async function createTemplateWithService(opts: {
  serviceName: string;
  vaultAppRoleRef?: string;
}): Promise<{ templateId: string; versionId: string }> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tpl-${templateId.slice(0, 6)}`,
      displayName: 'Route Test Template',
      source: 'user',
      scope: 'host',
      currentVersionId: null,
      draftVersionId: null,
    },
  });

  const versionId = createId();
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
      inputs: [{ name: 'apiKey', sensitive: true, required: true, rotateOnUpgrade: false }],
      vaultPolicies: [{ name: 'my-policy', body: 'path "secret/*" { capabilities = ["read"] }', scope: 'stack' }],
      vaultAppRoles: [{ name: 'my-approle', policy: 'my-policy', scope: 'stack' }],
      vaultKv: [],
    },
  });

  if (opts.vaultAppRoleRef) {
    await testPrisma.stackTemplateService.create({
      data: {
        id: createId(),
        versionId,
        serviceName: opts.serviceName,
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: 'latest',
        containerConfig: { restartPolicy: 'unless-stopped' },
        dependsOn: [],
        order: 0,
        vaultAppRoleRef: opts.vaultAppRoleRef,
      },
    });
  }

  return { templateId, versionId };
}

async function createBoundStack(opts: {
  templateId: string;
  templateVersion: number;
  encryptedInputValues?: string;
  services: Array<{ serviceName: string }>;
}): Promise<string> {
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: `route-test-${stackId.slice(0, 6)}`,
      networks: [],
      volumes: [],
      templateId: opts.templateId,
      templateVersion: opts.templateVersion,
      encryptedInputValues: opts.encryptedInputValues ?? null,
    },
  });

  for (const [i, svc] of opts.services.entries()) {
    await testPrisma.stackService.create({
      data: {
        id: createId(),
        stackId,
        serviceName: svc.serviceName,
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: 'latest',
        containerConfig: { restartPolicy: 'unless-stopped' },
        dependsOn: [],
        order: i,
      },
    });
  }

  return stackId;
}

/**
 * Create the VaultPolicy + VaultAppRole records that give the mock's returned
 * AppRole ID a valid FK target in the integration DB.
 */
async function createMockVaultAppRole(): Promise<void> {
  const polId = createId();
  await testPrisma.vaultPolicy.create({
    data: {
      id: polId,
      name: 'my-policy',
      displayName: 'my-policy',
    },
  });
  await testPrisma.vaultAppRole.create({
    data: {
      id: MOCK_AR_ID,
      name: 'my-approle',
      policyId: polId,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/stacks/:id/apply — vault phase route regression', () => {
  it('does not throw PrismaClientValidationError when stack has a service with a vault AppRole ref', async () => {
    const encrypted = encryptInputValues({ apiKey: 'test-key' });

    // Seed the VaultPolicy + VaultAppRole that the mock references so FK writes succeed.
    await createMockVaultAppRole();

    const { templateId } = await createTemplateWithService({
      serviceName: 'web',
      vaultAppRoleRef: 'my-approle',
    });

    const stackId = await createBoundStack({
      templateId,
      templateVersion: 1,
      encryptedInputValues: encrypted,
      services: [{ serviceName: 'web' }],
    });

    const app = buildApp();
    const res = await supertest(app).post(`/api/stacks/${stackId}/apply`).send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Wait for the background apply to complete (lock is released in the finally block).
    // First yield to allow the background task to start and acquire the lock,
    // then poll until the lock is released (signals completion).
    await new Promise((resolve) => setTimeout(resolve, 10));
    const deadline = Date.now() + 5000;
    while (stackOperationLock.has(stackId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // One more yield to allow any final async writes to flush.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Vault reconciler was called — proves the vault phase ran and the correct
    // Prisma query path was used (vaultAppRoleRef from StackTemplateService, not StackService).
    expect(runStackVaultReconciler).toHaveBeenCalled();

    // The atomic transaction wrote vaultAppRoleId onto the StackService row.
    const svc = await testPrisma.stackService.findFirst({
      where: { stackId },
    });
    expect(svc).not.toBeNull();
    expect(svc!.vaultAppRoleId).not.toBeNull();
  });

  it('does not blow up when stack has no template (non-vault stack)', async () => {
    const stackId = createId();
    await testPrisma.stack.create({
      data: {
        id: stackId,
        name: `no-template-${stackId.slice(0, 6)}`,
        networks: [],
        volumes: [],
      },
    });

    const app = buildApp();
    const res = await supertest(app).post(`/api/stacks/${stackId}/apply`).send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
