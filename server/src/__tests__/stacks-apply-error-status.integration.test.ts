/**
 * Integration test for the headline "stuck pending" fix (P0 item 1).
 *
 * A stack flipped to `pending` by a definition edit must NOT stay `pending`
 * forever when the background apply fails before the reconciler's own
 * end-of-run status write. Every pre-reconciler failure path (Vault / NATS /
 * JobPool-dry-run / plan-init) now persists `status: 'error'` +
 * `lastFailureReason` alongside its socket emit.
 *
 * Here we force the Vault phase to fail and assert the stack lands in `error`
 * with a meaningful reason.
 */

import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

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

// The Vault phase fails — this is the pre-reconciler failure that used to
// orphan the stack in `pending`.
vi.mock("../services/stacks/stack-vault-apply-orchestrator", () => ({
  runStackVaultApplyPhase: vi
    .fn()
    .mockResolvedValue({ status: "error", error: "vault boom" }),
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

import stacksApplyRoute from "../routes/stacks/stacks-apply-route";
import { stackOperationLock } from "../services/stacks/operation-lock";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksApplyRoute);
  app.use(errorHandler);
  return app;
}

async function createPendingStack(): Promise<string> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: "err-tpl-" + templateId.slice(0, 6),
      displayName: "Err Tpl",
      source: "user",
      scope: "host",
    },
  });
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: createId(),
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
      name: "err-stack-" + stackId.slice(0, 6),
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
      status: "pending",
    },
  });
  return stackId;
}

async function waitForBackgroundApply(stackId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (stackOperationLock.has(stackId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("POST /api/stacks/:id/apply — failure persists error status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips a pending stack to `error` with a reason when the Vault phase fails", async () => {
    const stackId = await createPendingStack();

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/apply`).send({});
    // The route accepts the apply (fire-and-forget) — the failure happens in
    // the background.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await waitForBackgroundApply(stackId);

    const stack = await testPrisma.stack.findUniqueOrThrow({ where: { id: stackId } });
    expect(stack.status).toBe("error");
    expect(stack.lastFailureReason).toBe("vault boom");

    // Lock must be released so the operator can retry.
    expect(stackOperationLock.has(stackId)).toBe(false);
  });
});
