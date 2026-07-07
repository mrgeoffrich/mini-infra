/**
 * Integration tests for the two prereq precheck endpoints (Phase 1):
 *   - GET /api/stacks/:stackId/prerequisites
 *   - GET /api/stack-templates/:templateId/prerequisites?environmentId=...
 */

import supertest from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { describe, it, expect, vi } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

vi.mock("../middleware/auth", () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string } }).user = { id: "session-user" };
    next();
  },
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

vi.mock("../services/vault/vault-services", () => ({
  vaultServicesReady: () => true,
  getVaultServices: () => ({
    stateService: { getMeta: async () => ({ bootstrappedAt: null }) },
    passphrase: { getState: () => "uninitialised" },
  }),
}));

import stackTemplateRouter from "../routes/stack-templates";
import stacksApplyRoute from "../routes/stacks/stacks-apply-route";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksApplyRoute);
  app.use("/api/stack-templates", stackTemplateRouter);
  // Real central error middleware — both routers now throw taxonomy errors
  // instead of writing their own response bodies.
  app.use(errorHandler);
  return app;
}

async function createTemplate(opts: {
  name: string;
  scope: "host" | "environment" | "any";
  withCurrentVersion?: boolean;
  requires?: object[];
}): Promise<{ templateId: string; versionId: string | null }> {
  const templateId = createId();
  let versionId: string | null = null;
  if (opts.withCurrentVersion ?? true) {
    versionId = createId();
    await testPrisma.stackTemplate.create({
      data: {
        id: templateId,
        name: opts.name,
        displayName: opts.name,
        source: "user",
        scope: opts.scope,
      },
    });
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
    await testPrisma.stackTemplate.update({
      where: { id: templateId },
      data: { currentVersionId: versionId },
    });
  } else {
    await testPrisma.stackTemplate.create({
      data: {
        id: templateId,
        name: opts.name,
        displayName: opts.name,
        source: "user",
        scope: opts.scope,
      },
    });
  }
  return { templateId, versionId };
}

describe("GET /api/stacks/:stackId/prerequisites", () => {
  it("returns ok: true for a stack with no template binding", async () => {
    const stackId = createId();
    await testPrisma.stack.create({
      data: { id: stackId, name: `s-${stackId.slice(0, 6)}`, networks: [], volumes: [] },
    });
    const res = await supertest(buildApp()).get(`/api/stacks/${stackId}/prerequisites`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(res.body.failures).toEqual([]);
  });

  it("returns ok: false with structured failures when prereqs unmet", async () => {
    const { templateId } = await createTemplate({
      name: "consumer-pre-" + createId().slice(0, 6),
      scope: "host",
      requires: [
        {
          kind: "stack",
          templateName: "missing-prereq",
          minState: "synced",
          scopeMatch: "host",
        },
      ],
    });
    const stackId = createId();
    await testPrisma.stack.create({
      data: {
        id: stackId,
        name: `s-${stackId.slice(0, 6)}`,
        networks: [],
        volumes: [],
        templateId,
        templateVersion: 1,
      },
    });
    const res = await supertest(buildApp()).get(`/api/stacks/${stackId}/prerequisites`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.failures).toHaveLength(1);
    expect(res.body.failures[0].kind).toBe("stack");
  });

  it("returns 404 for a stack that doesn't exist", async () => {
    const res = await supertest(buildApp()).get(`/api/stacks/never-existed/prerequisites`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/stack-templates/:templateId/prerequisites", () => {
  it("returns ok: true for a host-scoped template with no prereqs", async () => {
    const { templateId } = await createTemplate({
      name: "tpl-prefix-" + createId().slice(0, 6),
      scope: "host",
    });
    const res = await supertest(buildApp()).get(
      `/api/stack-templates/${templateId}/prerequisites`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("requires environmentId for environment-scoped templates", async () => {
    const { templateId } = await createTemplate({
      name: "tpl-env-" + createId().slice(0, 6),
      scope: "environment",
    });
    const res = await supertest(buildApp()).get(
      `/api/stack-templates/${templateId}/prerequisites`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_ENVIRONMENT_ID_REQUIRED");
  });

  it("returns 400 NO_PUBLISHED_VERSION when template has no current version", async () => {
    const { templateId } = await createTemplate({
      name: "tpl-noversion-" + createId().slice(0, 6),
      scope: "host",
      withCurrentVersion: false,
    });
    const res = await supertest(buildApp()).get(
      `/api/stack-templates/${templateId}/prerequisites`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_TEMPLATE_NOT_PUBLISHED");
  });

  it("evaluates against the supplied environmentId", async () => {
    // Set up a template with a same-environment prereq.
    const { templateId } = await createTemplate({
      name: "tpl-need-nats-" + createId().slice(0, 6),
      scope: "environment",
      requires: [
        {
          kind: "stack",
          templateName: "missing-nats-" + createId().slice(0, 6),
          minState: "synced",
          scopeMatch: "same-environment",
        },
      ],
    });
    const envId = createId();
    await testPrisma.environment.create({
      data: { id: envId, name: "e-" + envId.slice(0, 6), type: "nonproduction", networkType: "local" },
    });
    const res = await supertest(buildApp()).get(
      `/api/stack-templates/${templateId}/prerequisites?environmentId=${envId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.failures[0].kind).toBe("stack");
  });
});
