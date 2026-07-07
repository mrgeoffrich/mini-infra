/**
 * Reference integration test for Phase 3 of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md).
 *
 * Phase 3's Done-when: "Triggering the domain's canonical conflict/not-found
 * action (e.g. applying a stack that doesn't exist, or a duplicate
 * application/stack create) yields an actionable, correctly-attributed
 * message instead of a raw 500 or opaque string." This test pins both
 * canonical cases at the HTTP boundary, asserting the central error
 * middleware's envelope shape: `{ error: <ErrorCode>, message, resource,
 * action, requestId, timestamp }`.
 */
import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";
import { errorHandler } from "../lib/error-handler";

vi.mock("../middleware/auth", () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: "test-user" };
    next();
  },
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// The apply route pulls in a wide dependency graph (vault, NATS, HAProxy,
// monitoring) even though a missing-stack 404 never reaches any of it —
// stub the same surface `apply-route-prerequisites.integration.test.ts`
// already proves safe, so importing the route doesn't touch real services.
vi.mock("../services/stacks/stack-operation-context", () => ({
  buildStackOperationServices: vi.fn().mockResolvedValue({
    reconciler: { plan: vi.fn(), apply: vi.fn() },
  }),
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
import stacksCrudRoutes from "../routes/stacks/stacks-crud-routes";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksApplyRoute);
  app.use("/api/stacks", stacksCrudRoutes);
  // Real central error middleware — every stacks route now throws taxonomy
  // errors instead of writing its own response bodies.
  app.use(errorHandler);
  return app;
}

describe("Stacks domain — canonical conflict/not-found envelopes (Phase 3)", () => {
  it("POST /:stackId/apply on a stack that doesn't exist returns 404 STACK_NOT_FOUND", async () => {
    const missingStackId = createId();

    const res = await supertest(buildApp())
      .post(`/api/stacks/${missingStackId}/apply`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: "STACK_NOT_FOUND",
      message: "Stack not found",
      resource: { type: "stack", id: missingStackId },
      action: expect.any(String),
    });
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(res.body.timestamp).toEqual(expect.any(String));
  });

  it("POST / with a duplicate host-level stack name returns 409 STACK_NAME_EXISTS", async () => {
    const name = `dup-stack-${createId().slice(0, 8)}`;
    const body = {
      name,
      networks: [],
      volumes: [],
      services: [
        {
          serviceName: "web",
          serviceType: "Stateful",
          dockerImage: "nginx",
          dockerTag: "latest",
          containerConfig: {},
          dependsOn: [],
          order: 0,
        },
      ],
    };

    // First create succeeds.
    await supertest(buildApp()).post("/api/stacks").send(body).expect(201);

    // A second create with the same host-level name is a conflict, not a
    // raw 500 — and must attribute the conflict to the stack, by name.
    const res = await supertest(buildApp()).post("/api/stacks").send(body);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "STACK_NAME_EXISTS",
      message: expect.stringContaining("already exists"),
      resource: { type: "stack", name },
      action: expect.any(String),
    });
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(res.body.timestamp).toEqual(expect.any(String));
  });
});
