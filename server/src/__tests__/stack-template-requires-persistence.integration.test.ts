/**
 * HTTP regression test for `requires` persistence on
 * POST /api/stack-templates/:templateId/draft.
 *
 * Phase 1 of split-vault-nats. Catches the same class of bug as
 * `stack-templates-draft-route.integration.test.ts` did for
 * `vaultAppRoleRef`: a real POST body should round-trip a `requires[]`
 * block to the `StackTemplateVersion.requires` column, not be silently
 * stripped by Zod's default unknown-key behaviour.
 */

import supertest from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

vi.mock("../middleware/auth", () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string } }).user = { id: "session-user" };
    next();
  },
}));

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

import stackTemplateRouter from "../routes/stack-templates";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stack-templates", stackTemplateRouter);
  return app;
}

async function createUserTemplateRow(): Promise<string> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tpl-${templateId.slice(0, 6)}`,
      displayName: "Requires Test Template",
      source: "user",
      scope: "host",
      currentVersionId: null,
      draftVersionId: null,
    },
  });
  return templateId;
}

const baseService = {
  serviceName: "web",
  serviceType: "Stateful" as const,
  dockerImage: "nginx",
  dockerTag: "latest",
  containerConfig: {},
  dependsOn: [],
  order: 0,
};

describe("POST /api/stack-templates/:templateId/draft — requires[] persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a stack-kind requirement to the StackTemplateVersion.requires column", async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [baseService],
      requires: [
        {
          kind: "stack",
          templateName: "vault",
          minState: "synced",
          scopeMatch: "host",
        },
      ],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const tmpl = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    expect(tmpl?.draftVersionId).not.toBeNull();

    const row = await testPrisma.stackTemplateVersion.findUnique({
      where: { id: tmpl!.draftVersionId! },
    });
    expect(row?.requires).toEqual([
      { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
    ]);
  });

  it("persists a predicate-kind requirement when the predicate is registered", async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [baseService],
      requires: [{ kind: "predicate", name: "vault-bootstrapped" }],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(200);
    const tmpl = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    const row = await testPrisma.stackTemplateVersion.findUnique({
      where: { id: tmpl!.draftVersionId! },
    });
    expect(row?.requires).toEqual([{ kind: "predicate", name: "vault-bootstrapped" }]);
  });

  it("returns 400 when a predicate-kind requirement names an unregistered predicate", async () => {
    const templateId = await createUserTemplateRow();
    const draftBody = {
      networks: [],
      volumes: [],
      services: [baseService],
      requires: [{ kind: "predicate", name: "totally-made-up-predicate" }],
    };
    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);
    expect(res.status).toBe(400);
    const issues = res.body.issues as Array<{ message?: string }>;
    expect(issues.some((i) => i.message?.includes("Unknown predicate"))).toBe(true);
  });

  it("returns 400 when minState is not in the allowed set", async () => {
    const templateId = await createUserTemplateRow();
    const draftBody = {
      networks: [],
      volumes: [],
      services: [baseService],
      requires: [
        {
          kind: "stack",
          templateName: "vault",
          minState: "error", // not allowed
          scopeMatch: "host",
        },
      ],
    };
    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);
    expect(res.status).toBe(400);
  });

  it("treats omitting requires as the same as []", async () => {
    const templateId = await createUserTemplateRow();
    const draftBody = {
      networks: [],
      volumes: [],
      services: [baseService],
    };
    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);
    expect(res.status).toBe(200);
    const tmpl = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    const row = await testPrisma.stackTemplateVersion.findUnique({
      where: { id: tmpl!.draftVersionId! },
    });
    expect(row?.requires).toBeNull();
  });
});
