/**
 * Per-deployment snapshots + restore-to-any-deployment (P4 4.1).
 *
 * Before this, a stack had a single `lastAppliedSnapshot` and `revert-pending`
 * could only restore the LAST applied state — there was no way back to "the
 * definition that worked on Tuesday". `StackDeployment.snapshot` makes the
 * history a real timeline.
 *
 * The load-bearing detail these pin: the snapshot holds the RENDERED service
 * list, including synthetic addon sidecars, and restoring those as authored
 * StackService rows would duplicate the sidecars on the next apply. That bug was
 * caught once already in revert-pending (be644f3); history restore shares the
 * same code path precisely so it cannot be reintroduced here.
 */
import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

vi.mock("../middleware/auth", () => ({
  requirePermission:
    () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { user?: { id: string } }).user = { id: "test-user" };
      next();
    },
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));
vi.mock("../services/docker-executor", () => ({
  DockerExecutorService: class {
    async initialize() {}
    getDockerClient() {
      throw new Error("docker unavailable in test");
    }
  },
}));

import stacksHistoryRoutes from "../routes/stacks/stacks-history-routes";
import { stackOperationLock } from "../services/stacks/operation-lock";
import { pruneDeploymentSnapshots } from "../services/stacks/stack-restore-service";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksHistoryRoutes);
  app.use(errorHandler);
  return app;
}

/** A snapshot with one authored service and one synthetic addon sidecar. */
function snapshotWith(tag: string) {
  return {
    name: "hist-stack",
    description: "from snapshot",
    parameters: [],
    resourceOutputs: [],
    resourceInputs: [],
    networks: [],
    volumes: [],
    tlsCertificates: [],
    dnsRecords: [],
    tunnelIngress: [],
    services: [
      {
        serviceName: "web",
        serviceType: "Stateful",
        dockerImage: "nginx",
        dockerTag: tag,
        containerConfig: {},
        dependsOn: [],
        order: 0,
      },
      {
        // Synthetic addon sidecar — must NOT come back as an authored service.
        serviceName: "web-metrics",
        serviceType: "Stateful",
        dockerImage: "prom/exporter",
        dockerTag: "1.0",
        containerConfig: {},
        dependsOn: [],
        order: 1,
        synthetic: true,
      },
    ],
  };
}

async function seedStackWithDeployment(opts: { snapshot?: object | null } = {}) {
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: "hist-stack-" + stackId.slice(0, 6),
      networks: [],
      volumes: [],
      status: "synced",
      version: 5,
      lastAppliedVersion: 5,
      services: {
        create: [
          {
            serviceName: "web",
            serviceType: "Stateful",
            dockerImage: "nginx",
            dockerTag: "9.9", // the CURRENT definition, newer than the snapshot
            containerConfig: {},
            dependsOn: [],
            order: 0,
          },
        ],
      },
    },
  });

  const deployment = await testPrisma.stackDeployment.create({
    data: {
      stackId,
      action: "apply",
      success: true,
      version: 2,
      status: "synced",
      duration: 1000,
      ...(opts.snapshot !== null
        ? { snapshot: (opts.snapshot ?? snapshotWith("1.0")) as object }
        : {}),
    },
  });

  return { stackId, deploymentId: deployment.id };
}

describe("POST /api/stacks/:stackId/history/:deploymentId/restore", () => {
  it("restores the definition, drops synthetic sidecars, and lands `pending`", async () => {
    const { stackId, deploymentId } = await seedStackWithDeployment();

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/history/${deploymentId}/restore`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("pending");

    const stack = await testPrisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });

    // Definition came from the snapshot, not the live rows.
    expect(stack?.services.map((s) => s.serviceName)).toEqual(["web"]);
    expect(stack?.services[0]?.dockerTag).toBe("1.0");
    expect(stack?.description).toBe("from snapshot");

    // The version counter moves FORWARD — a restore is a new unapplied edit, and
    // rewriting history backwards would lie about what happened.
    expect(stack?.version).toBe(6);
    expect(stack?.status).toBe("pending");
  });

  it("400s for a deployment with no stored snapshot", async () => {
    // `stop` deployments never applied a definition, and rows predating the
    // column have nothing to restore.
    const { stackId, deploymentId } = await seedStackWithDeployment({ snapshot: null });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/history/${deploymentId}/restore`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_NO_APPLIED_SNAPSHOT");
  });

  it("404s for a deployment belonging to another stack", async () => {
    const { stackId } = await seedStackWithDeployment();
    const other = await seedStackWithDeployment();

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/history/${other.deploymentId}/restore`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("STACK_DEPLOYMENT_NOT_FOUND");
  });

  it("409s when an operation is already in progress", async () => {
    const { stackId, deploymentId } = await seedStackWithDeployment();
    stackOperationLock.tryAcquire(stackId);
    try {
      const res = await supertest(buildApp())
        .post(`/api/stacks/${stackId}/history/${deploymentId}/restore`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("STACK_OPERATION_IN_PROGRESS");
    } finally {
      stackOperationLock.release(stackId);
    }
  });
});

describe("GET /api/stacks/:stackId/history", () => {
  it("reports hasSnapshot without shipping the snapshot itself", async () => {
    // A snapshot is a whole stack definition; 100 of them would dwarf the list.
    const { stackId } = await seedStackWithDeployment();

    const res = await supertest(buildApp()).get(`/api/stacks/${stackId}/history`);
    expect(res.status).toBe(200);
    const [entry] = res.body.data;
    expect(entry.hasSnapshot).toBe(true);
    expect(entry.snapshot).toBeUndefined();
  });
});

describe("pruneDeploymentSnapshots", () => {
  it("keeps the newest N snapshots and drops the payload from older rows", async () => {
    const { stackId } = await seedStackWithDeployment();

    // 4 more snapshot-bearing deployments (5 total).
    for (let i = 0; i < 4; i++) {
      await testPrisma.stackDeployment.create({
        data: {
          stackId,
          action: "apply",
          success: true,
          version: 3 + i,
          status: "synced",
          snapshot: snapshotWith(`${i}.0`) as object,
        },
      });
    }

    await pruneDeploymentSnapshots(testPrisma, stackId, 2);

    const rows = await testPrisma.stackDeployment.findMany({
      where: { stackId },
      orderBy: { createdAt: "desc" },
    });
    // Rows survive — the audit trail of what happened is never rewritten.
    expect(rows).toHaveLength(5);
    // Only the restorable payload is dropped.
    expect(rows.filter((r) => r.snapshot != null)).toHaveLength(2);
  });
});
