/**
 * Integration test for POST /api/stacks/:stackId/revert-pending (P2, feedback
 * niceties). Revert discards unapplied definition edits by restoring the stack
 * from its last applied snapshot and flipping status back to `synced`.
 */
import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

vi.mock("../middleware/auth", () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: "test-user" };
    next();
  },
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

import stacksRevertRoute from "../routes/stacks/stacks-revert-route";
import { stackOperationLock } from "../services/stacks/operation-lock";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksRevertRoute);
  app.use(errorHandler);
  return app;
}

/**
 * Seeds a `pending` stack whose live definition (web@2.0 + worker) differs from
 * its last applied snapshot (web@1.0 only). version=5, lastAppliedVersion=4.
 */
async function seedPendingStackWithSnapshot(): Promise<string> {
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: "revert-stack-" + stackId.slice(0, 6),
      networks: [],
      volumes: [],
      status: "pending",
      version: 5,
      lastAppliedVersion: 4,
      lastAppliedAt: new Date(),
      lastAppliedSnapshot: {
        name: "revert-stack-" + stackId.slice(0, 6),
        networks: [],
        volumes: [],
        services: [
          {
            serviceName: "web",
            serviceType: "Stateful",
            dockerImage: "nginx",
            dockerTag: "1.0",
            containerConfig: {},
            dependsOn: [],
            order: 0,
          },
        ],
      },
      services: {
        create: [
          {
            serviceName: "web",
            serviceType: "Stateful",
            dockerImage: "nginx",
            dockerTag: "2.0",
            containerConfig: {},
            dependsOn: [],
            order: 0,
          },
          {
            serviceName: "worker",
            serviceType: "Stateful",
            dockerImage: "nginx",
            dockerTag: "2.0",
            containerConfig: {},
            dependsOn: [],
            order: 1,
          },
        ],
      },
    },
  });
  return stackId;
}

describe("POST /api/stacks/:stackId/revert-pending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores the definition from the snapshot and sets synced", async () => {
    const stackId = await seedPendingStackWithSnapshot();

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/revert-pending`).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("synced");
    // Version rewound to the last applied revision.
    expect(res.body.data.version).toBe(4);

    const stack = await testPrisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });
    expect(stack?.status).toBe("synced");
    // Services re-materialized from the snapshot: only web@1.0 (worker dropped).
    const svcNames = stack?.services.map((s) => s.serviceName).sort();
    expect(svcNames).toEqual(["web"]);
    expect(stack?.services.find((s) => s.serviceName === "web")?.dockerTag).toBe("1.0");
  });

  it("does not restore synthetic addon sidecars as authored services", async () => {
    const stackId = await seedPendingStackWithSnapshot();
    // The applied snapshot holds the RENDERED service list — replace it with one
    // that includes a synthetic sidecar, as a successful apply of an
    // addon-bearing stack produces.
    await testPrisma.stack.update({
      where: { id: stackId },
      data: {
        lastAppliedSnapshot: {
          name: "revert-stack-" + stackId.slice(0, 6),
          networks: [],
          volumes: [],
          services: [
            {
              serviceName: "web",
              serviceType: "Stateful",
              dockerImage: "nginx",
              dockerTag: "1.0",
              containerConfig: {},
              dependsOn: [],
              order: 0,
              addons: { "tailscale-web": {} },
            },
            {
              serviceName: "web-tailscale",
              serviceType: "Stateful",
              dockerImage: "tailscale/tailscale",
              dockerTag: "stable",
              containerConfig: {},
              dependsOn: [],
              order: 1,
              synthetic: { addon: "tailscale-web", parentService: "web" },
            },
          ],
        },
      },
    });

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/revert-pending`).send({});
    expect(res.status).toBe(200);

    const stack = await testPrisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });
    // Only the authored service is restored; the sidecar must not become an
    // authored row (the next apply re-expands addons and would duplicate it).
    expect(stack?.services.map((s) => s.serviceName)).toEqual(["web"]);
  });

  it("returns 400 STACK_NO_APPLIED_SNAPSHOT for a never-applied stack", async () => {
    const stackId = createId();
    await testPrisma.stack.create({
      data: {
        id: stackId,
        name: "no-snap-" + stackId.slice(0, 6),
        networks: [],
        volumes: [],
        status: "pending",
      },
    });

    const res = await supertest(buildApp()).post(`/api/stacks/${stackId}/revert-pending`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_NO_APPLIED_SNAPSHOT");
  });

  it("returns 409 when an operation is already in progress", async () => {
    const stackId = await seedPendingStackWithSnapshot();
    stackOperationLock.tryAcquire(stackId);
    try {
      const res = await supertest(buildApp())
        .post(`/api/stacks/${stackId}/revert-pending`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("STACK_OPERATION_IN_PROGRESS");
    } finally {
      stackOperationLock.release(stackId);
    }
  });

  it("returns 404 for an unknown stack", async () => {
    const res = await supertest(buildApp())
      .post(`/api/stacks/${createId()}/revert-pending`)
      .send({});
    expect(res.status).toBe(404);
  });
});
