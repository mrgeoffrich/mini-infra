/**
 * The contract between the Compose mapper and the template schema.
 *
 * `mapComposeToTemplate` lives in `@mini-infra/types` and produces the draft the
 * client POSTs to `POST /api/stack-templates`. Its unit tests prove it maps
 * Compose *correctly*; they cannot prove the shapes it emits are ones the server
 * will actually *accept* — the schema is the other side of a seam the mapper
 * never sees.
 *
 * That is precisely the class of bug that gets caught in a browser rather than a
 * test run: an import that looks right and 400s on submit. So this drives the
 * mapper's real output through the real route.
 *
 * The mapper takes an already-parsed document, so no YAML parser is needed here —
 * the object literals below are what `yaml.load()` would hand it.
 */
import supertest from "supertest";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { mapComposeToTemplate } from "@mini-infra/types";
import { testPrisma } from "./integration-test-helpers";

vi.mock("../middleware/auth", () => ({
  requirePermission:
    () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { user?: { id: string } }).user = { id: "test-user" };
      next();
    },
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

import stackTemplatesRoute from "../routes/stack-templates";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stack-templates", stackTemplatesRoute);
  app.use(errorHandler);
  return app;
}

/** Map a compose doc, then create a template from it exactly as the UI does. */
async function importAndCreate(doc: unknown) {
  const result = mapComposeToTemplate(doc);
  expect(result.ok, `mapper refused the document: ${JSON.stringify(result.issues)}`).toBe(true);

  const name = `imported-${createId().slice(0, 8)}`;
  const res = await supertest(buildApp())
    .post("/api/stack-templates")
    .send({
      name,
      displayName: name,
      scope: "environment",
      networks: result.draft!.networks,
      volumes: result.draft!.volumes,
      services: result.draft!.services,
    });

  return { result, res };
}

describe("Compose import → template schema contract", () => {
  it("accepts a realistic multi-service compose file", async () => {
    // Ports, named volumes, env, healthcheck, depends_on, restart, networks —
    // the shapes most likely to drift from what the schema wants.
    const { result, res } = await importAndCreate({
      services: {
        db: {
          image: "postgres:16",
          environment: { POSTGRES_PASSWORD: "secret" },
          volumes: ["pgdata:/var/lib/postgresql/data"],
          healthcheck: {
            test: ["CMD-SHELL", "pg_isready -U postgres"],
            interval: "10s",
            timeout: "5s",
            retries: 5,
          },
          restart: "unless-stopped",
          networks: ["backend"],
        },
        api: {
          image: "ghcr.io/acme/api:v1.4.2",
          depends_on: ["db"],
          ports: ["8080:8080"],
          environment: ["DATABASE_URL=postgres://db:5432/app", "LOG_LEVEL=info"],
          command: ["node", "server.js"],
          restart: "on-failure:5",
          networks: ["backend"],
        },
      },
      volumes: { pgdata: null },
      networks: { backend: { driver: "bridge" } },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // The route persisted the mapped shapes, not a stripped-down version of them.
    const versionId = res.body.data.currentVersionId ?? undefined;
    const services = await testPrisma.stackTemplateService.findMany({
      where: { version: { templateId: res.body.data.id } },
      orderBy: { order: "asc" },
    });

    expect(services.map((s) => s.serviceName)).toEqual(["db", "api"]); // depends_on order
    expect(services[0].dockerImage).toBe("postgres");
    expect(services[0].dockerTag).toBe("16");
    expect(services[1].dockerImage).toBe("ghcr.io/acme/api");
    expect(services[1].dockerTag).toBe("v1.4.2");

    const apiConfig = services[1].containerConfig as Record<string, unknown>;
    expect(apiConfig.ports).toEqual([
      { containerPort: 8080, hostPort: 8080, protocol: "tcp", exposeOnHost: true },
    ]);
    // `on-failure:5` keeps the policy, drops the count — and the schema takes it.
    expect(apiConfig.restartPolicy).toBe("on-failure");

    const dbConfig = services[0].containerConfig as Record<string, unknown>;
    expect(dbConfig.healthcheck).toMatchObject({ interval: 10_000, timeout: 5_000, retries: 5 });

    expect(result.issues.some((i) => i.level === "error")).toBe(false);
    void versionId;
  });

  it("accepts a service whose command came through as a shell string", async () => {
    const { res } = await importAndCreate({
      services: {
        worker: { image: "worker:1", command: "python -m worker --verbose" },
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const svc = await testPrisma.stackTemplateService.findFirst({
      where: { version: { templateId: res.body.data.id } },
    });
    expect((svc!.containerConfig as Record<string, unknown>).command).toEqual([
      "/bin/sh",
      "-c",
      "python -m worker --verbose",
    ]);
  });

  it("accepts an absolute bind mount (the schema's blocklist permits it)", async () => {
    // The mapper flags bind mounts as lossy but still emits them. The schema has
    // a blocklist refine on bind sources, so this pins that an ordinary host path
    // survives the round trip.
    const { res } = await importAndCreate({
      services: {
        app: { image: "app:1", volumes: ["/srv/appdata:/data"] },
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const svc = await testPrisma.stackTemplateService.findFirst({
      where: { version: { templateId: res.body.data.id } },
    });
    expect((svc!.containerConfig as Record<string, unknown>).mounts).toEqual([
      { source: "/srv/appdata", target: "/data", type: "bind", readOnly: false },
    ]);
  });

  it("emits a healthcheck the schema accepts (durations are ms, retries is a count)", async () => {
    const { res } = await importAndCreate({
      services: {
        app: {
          image: "app:1",
          healthcheck: { test: "curl -f http://localhost/health", interval: "1m30s" },
        },
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const svc = await testPrisma.stackTemplateService.findFirst({
      where: { version: { templateId: res.body.data.id } },
    });
    const hc = (svc!.containerConfig as Record<string, unknown>).healthcheck as Record<string, unknown>;
    // String test form is Compose's shell form.
    expect(hc.test).toEqual(["CMD-SHELL", "curl -f http://localhost/health"]);
    expect(hc.interval).toBe(90_000);
  });
});
