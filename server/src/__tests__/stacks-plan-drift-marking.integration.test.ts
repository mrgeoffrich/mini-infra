/**
 * Integration test for post-plan drift marking (P1 item 11).
 *
 * GET /api/stacks/:stackId/plan persists `drifted` when a currently-`synced`
 * stack's plan shows changes, and flips a `drifted` stack back to `synced` when
 * its plan is clean again. There is no background scanner — this is on-demand.
 */
import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

const { mockPlan } = vi.hoisted(() => ({ mockPlan: vi.fn() }));

vi.mock("../services/docker-executor", () => ({
  DockerExecutorService: class {
    async initialize(): Promise<void> {}
  },
}));

vi.mock("../services/stacks/stack-reconciler", () => ({
  StackReconciler: class {
    plan = mockPlan;
  },
}));

vi.mock("../services/stacks/resource-reconciler-factory", () => ({
  createResourceReconciler: vi.fn(async () => undefined),
}));

vi.mock("../services/stacks/stack-config-requirements", () => ({
  checkStackConfigurationRequirements: vi.fn(async () => null),
}));

vi.mock("../middleware/auth", () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: "test-user" };
    next();
  },
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

import stacksValidationRoute from "../routes/stacks/stacks-validation-routes";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksValidationRoute);
  app.use(errorHandler);
  return app;
}

async function createStack(status: string): Promise<string> {
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: "drift-stack-" + stackId.slice(0, 6),
      networks: [],
      volumes: [],
      status,
    },
  });
  return stackId;
}

function planResult(hasChanges: boolean) {
  return {
    stackId: "x",
    stackName: "x",
    stackVersion: 1,
    planTime: new Date().toISOString(),
    actions: [],
    resourceActions: [],
    networkActions: [],
    hasChanges,
  };
}

describe("GET /api/stacks/:stackId/plan — drift marking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a synced stack drifted when the plan has changes", async () => {
    const stackId = await createStack("synced");
    mockPlan.mockResolvedValue(planResult(true));

    const res = await supertest(buildApp()).get(`/api/stacks/${stackId}/plan`);
    expect(res.status).toBe(200);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(stack?.status).toBe("drifted");
  });

  it("flips a drifted stack back to synced when the plan is clean", async () => {
    const stackId = await createStack("drifted");
    mockPlan.mockResolvedValue(planResult(false));

    await supertest(buildApp()).get(`/api/stacks/${stackId}/plan`).expect(200);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(stack?.status).toBe("synced");
  });

  it("leaves a synced stack synced when the plan is clean", async () => {
    const stackId = await createStack("synced");
    mockPlan.mockResolvedValue(planResult(false));

    await supertest(buildApp()).get(`/api/stacks/${stackId}/plan`).expect(200);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(stack?.status).toBe("synced");
  });

  it("does not touch a pending stack even if the plan has changes", async () => {
    const stackId = await createStack("pending");
    mockPlan.mockResolvedValue(planResult(true));

    await supertest(buildApp()).get(`/api/stacks/${stackId}/plan`).expect(200);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(stack?.status).toBe("pending");
  });
});
