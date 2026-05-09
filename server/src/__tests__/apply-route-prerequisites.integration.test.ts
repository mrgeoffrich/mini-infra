/**
 * Integration test for the cross-stack prereqs gate on
 * POST /api/stacks/:id/apply (Phase 1 of split-vault-nats).
 *
 * Asserts:
 *   1. A stack whose template version has unmet prereqs returns 409
 *      `PREREQUISITES_NOT_MET` with structured failures.
 *   2. The 409 path does NOT create a UserEvent (apply didn't start —
 *      the audit trail must not be polluted by prechecks).
 *   3. A stack whose prereqs are satisfied returns 200/202 and runs
 *      the apply pipeline normally.
 */

import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

// Hoisted mocks — buildStackOperationServices, vault, socket emitters,
// monitoring, haproxy. Same shape as `stacks-apply-vault-route.integration.test.ts`.

const { mockPlan, mockApply } = vi.hoisted(() => {
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

  return { mockPlan, mockApply };
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
    stateService: { getMeta: async () => null },
    passphrase: { getState: () => "uninitialised" },
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

async function createTemplateAndStack(opts: {
  templateName: string;
  requires?: object[];
  stackStatus?: string;
}): Promise<{ stackId: string; templateId: string }> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: opts.templateName,
      displayName: opts.templateName,
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
      requires: opts.requires ? (opts.requires as unknown as object) : undefined,
    },
  });

  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: `${opts.templateName}-stack-${stackId.slice(0, 6)}`,
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
      status: (opts.stackStatus ?? "pending") as never,
    },
  });

  return { stackId, templateId };
}

describe("POST /api/stacks/:id/apply — cross-stack prerequisites gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 PREREQUISITES_NOT_MET when a stack-kind requirement fails", async () => {
    const { stackId } = await createTemplateAndStack({
      templateName: "consumer-pre-" + createId().slice(0, 6),
      requires: [
        { kind: "stack", templateName: "missing-prereq", minState: "synced", scopeMatch: "host" },
      ],
    });

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/apply`).send({});
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("PREREQUISITES_NOT_MET");
    expect(Array.isArray(res.body.failures)).toBe(true);
    expect(res.body.failures[0].kind).toBe("stack");
    expect(res.body.failures[0].helpAction.type).toBe("instantiate-stack");
    expect(res.body.failures[0].helpAction.templateName).toBe("missing-prereq");

    // 409 must NOT pollute the audit trail.
    const events = await testPrisma.userEvent.findMany({ where: { resourceId: stackId } });
    expect(events).toEqual([]);

    // Lock must not have been acquired.
    expect(stackOperationLock.has(stackId)).toBe(false);
  });

  it("returns 200 and starts apply when prereqs are satisfied", async () => {
    const prereqTemplateName = "satisfier-" + createId().slice(0, 6);
    const { templateId: prereqTpl } = await createTemplateAndStack({
      templateName: prereqTemplateName,
      stackStatus: "synced",
    });
    expect(prereqTpl).toBeDefined();

    const { stackId } = await createTemplateAndStack({
      templateName: "consumer-ok-" + createId().slice(0, 6),
      requires: [
        { kind: "stack", templateName: prereqTemplateName, minState: "synced", scopeMatch: "host" },
      ],
    });

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/apply`).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Wait for background apply to complete (lock release signals done).
    const deadline = Date.now() + 5000;
    while (stackOperationLock.has(stackId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(mockPlan).toHaveBeenCalled();
  });

  it("returns 200 when the stack has no template (no requires possible)", async () => {
    const stackId = createId();
    await testPrisma.stack.create({
      data: {
        id: stackId,
        name: "no-template-" + stackId.slice(0, 6),
        networks: [],
        volumes: [],
      },
    });
    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/apply`).send({});
    expect(res.status).toBe(200);
  });
});
