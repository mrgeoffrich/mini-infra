/**
 * Integration test for POST /api/stacks/:stackId/stop (P0 item 3).
 *
 * The honest "Stop": undeploy-but-keep. Unlike /destroy (which deletes the
 * stack row), /stop stops the containers and flips status to `undeployed`
 * while KEEPING the definition + DB row, so the stack can be deployed again
 * without re-instantiating.
 */

import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

const { mockStopStack } = vi.hoisted(() => ({ mockStopStack: vi.fn() }));

vi.mock("../services/docker-executor", () => ({
  DockerExecutorService: class {
    async initialize(): Promise<void> {}
  },
}));

vi.mock("../services/stacks/stack-reconciler", () => ({
  StackReconciler: class {
    stopStack = mockStopStack;
  },
}));

vi.mock("../middleware/auth", () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: "test-user" };
    next();
  },
}));

vi.mock("../services/stacks/stack-socket-emitter", () => ({
  emitStackStopStarted: vi.fn(),
  emitStackStopCompleted: vi.fn(),
  emitStackStopFailed: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

import stacksStopRoute from "../routes/stacks/stacks-stop-route";
import { stackOperationLock } from "../services/stacks/operation-lock";
import {
  emitStackStopCompleted,
  emitStackStopStarted,
} from "../services/stacks/stack-socket-emitter";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksStopRoute);
  app.use(errorHandler);
  return app;
}

async function createSyncedStack(): Promise<string> {
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: "stop-stack-" + stackId.slice(0, 6),
      networks: [],
      volumes: [],
      status: "synced",
    },
  });
  return stackId;
}

async function waitForBackground(stackId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (stackOperationLock.has(stackId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("POST /api/stacks/:stackId/stop", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The mocked auth sets userId "test-user"; the audit UserEvent has a FK to
    // User, so seed the row or createEvent silently fails and no audit lands.
    await testPrisma.user.upsert({
      where: { id: "test-user" },
      update: {},
      create: {
        id: "test-user",
        email: "test-user@example.com",
        name: "Test User",
      },
    });
    // Mimic the real reconciler.stopStack: flip status to undeployed, keep row.
    mockStopStack.mockImplementation(async (stackId: string) => {
      await testPrisma.stack.update({
        where: { id: stackId },
        data: { status: "undeployed" },
      });
      return { success: true, stoppedContainers: 3 };
    });
  });

  it("stops the stack, KEEPS the row, and sets status to undeployed", async () => {
    const stackId = await createSyncedStack();

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/stop`).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await waitForBackground(stackId);

    expect(mockStopStack).toHaveBeenCalledWith(stackId, expect.anything());

    // Row is KEPT (this is the whole point — not a destroy).
    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(stack).not.toBeNull();
    expect(stack?.status).toBe("undeployed");

    expect(emitStackStopStarted).toHaveBeenCalled();
    expect(emitStackStopCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, stackId, stoppedContainers: 3 }),
    );

    // A stack_stop audit event was recorded.
    const events = await testPrisma.userEvent.findMany({ where: { resourceId: stackId } });
    expect(events.some((e) => e.eventType === "stack_stop")).toBe(true);
  });

  it("returns 409 when an operation is already in progress", async () => {
    const stackId = await createSyncedStack();
    stackOperationLock.tryAcquire(stackId);
    try {
      const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/stop`).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("STACK_OPERATION_IN_PROGRESS");
      expect(mockStopStack).not.toHaveBeenCalled();
    } finally {
      stackOperationLock.release(stackId);
    }
  });

  it("returns 404 for an unknown stack", async () => {
    const res = await supertest(buildApp())
      .post(`/api/stacks/${createId()}/stop`)
      .send({});
    expect(res.status).toBe(404);
  });
});
