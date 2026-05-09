/**
 * Phase 2 integration test for the cross-stack prereqs on the new `nats`
 * host stack. Asserts the end-to-end shape:
 *
 *   1. A stack instantiated from the `nats` template with no `vault` stack
 *      present and Vault not bootstrapped → POST /apply returns 409
 *      PREREQUISITES_NOT_MET with both failures (stack + predicate) and
 *      includes the `open-vault-bootstrap` helpAction for the predicate.
 *   2. Once a `vault` stack is `synced` AND vaultBootstrapped predicate
 *      returns ok, the same /apply returns 200 and the apply pipeline
 *      runs.
 *
 * Mocks vault-services to control the predicate result without booting a
 * real OpenBao container. Mirrors the layered-mock pattern in
 * `apply-route-prerequisites.integration.test.ts`.
 */

import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

// Hoisted mocks
const { mockPlan, mockApply, mockVaultMeta, mockPassphraseState } = vi.hoisted(() => {
  const mockPlan = vi.fn().mockResolvedValue({
    stackId: "ignored",
    stackName: "test",
    stackVersion: 1,
    planTime: new Date().toISOString(),
    actions: [],
    resourceActions: [],
    hasChanges: false,
  });

  const mockApply = vi.fn().mockResolvedValue({
    success: true,
    stackId: "ignored",
    appliedVersion: 1,
    serviceResults: [],
    resourceResults: [],
    duration: 0,
  });

  // Default: Vault not bootstrapped, locked.
  const mockVaultMeta = vi.fn().mockResolvedValue(null);
  const mockPassphraseState = vi.fn().mockReturnValue("uninitialised");

  return { mockPlan, mockApply, mockVaultMeta, mockPassphraseState };
});

vi.mock("../services/stacks/stack-operation-context", () => ({
  buildStackOperationServices: vi.fn().mockResolvedValue({
    reconciler: { plan: mockPlan, apply: mockApply },
  }),
}));

vi.mock("../middleware/auth", () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: "test-user" };
    next();
  },
}));

vi.mock("../services/vault/vault-services", () => ({
  vaultServicesReady: vi.fn().mockReturnValue(true),
  getVaultServices: vi.fn().mockReturnValue({
    admin: {},
    stateService: { getMeta: () => mockVaultMeta() },
    passphrase: { getState: () => mockPassphraseState() },
  }),
}));

vi.mock("../services/stacks/stack-vault-apply-orchestrator", () => ({
  runStackVaultApplyPhase: vi.fn().mockResolvedValue({ status: "skipped" }),
}));

vi.mock("../services/stacks/stack-nats-apply-orchestrator", () => ({
  runStackNatsApplyPhase: vi.fn().mockResolvedValue({ status: "skipped" }),
}));

vi.mock("../services/stacks/stack-socket-emitter", () => ({
  emitStackApplyStarted: vi.fn(),
  emitStackApplyServiceResult: vi.fn(),
  emitStackApplyCompleted: vi.fn(),
  emitStackApplyFailed: vi.fn(),
  emitStackAddonProvisioned: vi.fn(),
  emitStackAddonFailed: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

vi.mock("../services/haproxy/haproxy-post-apply", () => ({
  restoreHAProxyRuntimeState: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../services/monitoring", () => ({
  MonitoringService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    ensureAppConnectedToMonitoringNetwork: vi.fn().mockResolvedValue(undefined),
  })),
}));

import stacksApplyRoute from "../routes/stacks/stacks-apply-route";
import { stackOperationLock } from "../services/stacks/operation-lock";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksApplyRoute);
  return app;
}

const NATS_REQUIRES = [
  { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
  { kind: "predicate", name: "vault-bootstrapped" },
];

async function createNatsTemplateAndStack(): Promise<{ stackId: string; templateId: string }> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: "nats-test-" + createId().slice(0, 6),
      displayName: "NATS Test",
      source: "user",
      scope: "host",
    },
  });

  const versionId = createId();
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId,
      version: 1,
      status: "published",
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      requires: NATS_REQUIRES as unknown as object,
    },
  });

  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: "nats-stack-" + stackId.slice(0, 6),
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
      status: "pending" as never,
    },
  });

  return { stackId, templateId };
}

async function createSyncedVaultStack(): Promise<string> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: "vault",
      displayName: "Vault",
      source: "user",
      scope: "host",
    },
  });
  const versionId = createId();
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId,
      version: 1,
      status: "published",
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
    },
  });
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: "vault",
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
      status: "synced" as never,
    },
  });
  return stackId;
}

describe("Phase 2: nats template requires gate end-to-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: Vault not bootstrapped, locked.
    mockVaultMeta.mockResolvedValue(null);
    mockPassphraseState.mockReturnValue("uninitialised");
  });

  it("returns 409 with both failures when neither vault stack nor bootstrap exists", async () => {
    // The harness truncates the DB between tests, so no `vault` template
    // exists yet — the stack-kind requirement is unsatisfiable by default.
    const { stackId } = await createNatsTemplateAndStack();

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/apply`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PREREQUISITES_NOT_MET");
    expect(res.body.failures).toHaveLength(2);

    const stackFailure = res.body.failures.find((f: { kind: string }) => f.kind === "stack");
    expect(stackFailure).toBeDefined();
    expect(stackFailure.helpAction.type).toBe("instantiate-stack");
    expect(stackFailure.helpAction.templateName).toBe("vault");

    const predicateFailure = res.body.failures.find((f: { kind: string }) => f.kind === "predicate");
    expect(predicateFailure).toBeDefined();
    expect(predicateFailure.helpAction.type).toBe("open-vault-bootstrap");

    // No UserEvent — the precheck blocked dispatch entirely.
    const events = await testPrisma.userEvent.findMany({ where: { resourceId: stackId } });
    expect(events).toEqual([]);
    expect(stackOperationLock.has(stackId)).toBe(false);
  });

  it("returns 200 once vault stack is synced AND vault-bootstrapped predicate flips", async () => {
    // Harness truncates between tests; seed the satisfiers fresh.
    await createSyncedVaultStack();
    mockVaultMeta.mockResolvedValue({ bootstrappedAt: new Date(), address: "http://vault:8200", stackId: null });
    mockPassphraseState.mockReturnValue("unlocked");

    const { stackId } = await createNatsTemplateAndStack();

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/apply`).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Wait for the background apply to release the lock so the test
    // doesn't leak state into the next case.
    const deadline = Date.now() + 5000;
    while (stackOperationLock.has(stackId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mockPlan).toHaveBeenCalled();
  });

  it("returns 409 when vault stack is synced but bootstrap predicate still says locked", async () => {
    // Harness truncates between tests; seed the satisfiers fresh.
    await createSyncedVaultStack();
    // Bootstrapped but locked — the predicate's "unlocked" gate must still fail.
    mockVaultMeta.mockResolvedValue({ bootstrappedAt: new Date(), address: "http://vault:8200", stackId: null });
    mockPassphraseState.mockReturnValue("locked");

    const { stackId } = await createNatsTemplateAndStack();

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/apply`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PREREQUISITES_NOT_MET");
    // Stack-kind requirement is satisfied — only the predicate should fail.
    expect(res.body.failures).toHaveLength(1);
    expect(res.body.failures[0].kind).toBe("predicate");
    expect(res.body.failures[0].helpAction.type).toBe("open-vault-bootstrap");
  });
});
