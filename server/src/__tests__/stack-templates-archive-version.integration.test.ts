/**
 * POST /api/stack-templates/:templateId/versions/:versionId/archive (P4 4.4).
 *
 * `StackTemplateVersionStatus.archived` was in the enum from the start but
 * nothing ever wrote it — the sidebar's archived section was unreachable and the
 * status was decorative. These pin the write side, and the guards that make an
 * archived version actually mean something: it can't be instantiated, upgraded
 * to, or made current.
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

import stackTemplatesRoute from "../routes/stack-templates";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stack-templates", stackTemplatesRoute);
  app.use(errorHandler);
  return app;
}

async function seedVersion(templateId: string, version: number, status: string) {
  const id = createId();
  await testPrisma.stackTemplateVersion.create({
    data: {
      id,
      templateId,
      version,
      status: status as "draft" | "published" | "archived",
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      publishedAt: status === "draft" ? null : new Date(),
      services: {
        create: [
          {
            serviceName: "web",
            serviceType: "Stateful",
            dockerImage: "nginx",
            dockerTag: `${version}.0`,
            containerConfig: {},
            dependsOn: [],
            order: 0,
          },
        ],
      },
    },
  });
  return id;
}

/** User template with v1 + v2 published; current → v2. */
async function seedTemplate(opts: { source?: "user" | "system" } = {}) {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: "arch-tpl-" + templateId.slice(0, 6),
      displayName: "Archive Template",
      source: opts.source ?? "user",
      scope: "any",
    },
  });
  const v1Id = await seedVersion(templateId, 1, "published");
  const v2Id = await seedVersion(templateId, 2, "published");
  await testPrisma.stackTemplate.update({
    where: { id: templateId },
    data: { currentVersionId: v2Id },
  });
  return { templateId, v1Id, v2Id };
}

describe("POST /api/stack-templates/:templateId/versions/:versionId/archive", () => {
  it("archives an old published version, and restores it again", async () => {
    const { templateId, v1Id } = await seedTemplate();

    const archived = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${v1Id}/archive`)
      .send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe("archived");

    let row = await testPrisma.stackTemplateVersion.findUnique({ where: { id: v1Id } });
    expect(row?.status).toBe("archived");

    const restored = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${v1Id}/archive`)
      .send({ archived: false });
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe("published");

    row = await testPrisma.stackTemplateVersion.findUnique({ where: { id: v1Id } });
    expect(row?.status).toBe("published");
  });

  it("refuses to archive the template's current version", async () => {
    // A template pointing at an archived version could not instantiate or
    // upgrade anything — that is a wedged template, not a retired version.
    const { templateId, v2Id } = await seedTemplate();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${v2Id}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_IS_CURRENT");

    const row = await testPrisma.stackTemplateVersion.findUnique({ where: { id: v2Id } });
    expect(row?.status).toBe("published");
  });

  it("refuses to archive a draft", async () => {
    // Drafts are discarded, not archived — archiving one would strand the
    // template's in-progress edit where nothing can publish or discard it.
    const { templateId } = await seedTemplate();
    const draftId = await seedVersion(templateId, 0, "draft");

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${draftId}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_PUBLISHED");
  });

  it("rejects a version belonging to another template with 404", async () => {
    const { templateId } = await seedTemplate();
    const other = await seedTemplate();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${other.v1Id}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_FOUND");
  });

  it("refuses to archive a system template's version", async () => {
    const { templateId, v1Id } = await seedTemplate({ source: "system" });

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${v1Id}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("STACK_TEMPLATE_SYSTEM_IMMUTABLE");
  });

  it("400s when `archived` isn't a boolean", async () => {
    const { templateId, v1Id } = await seedTemplate();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${v1Id}/archive`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_FAILED");
  });

  it("makes an archived version un-rollback-to-able", async () => {
    // The rollback guard already existed; this pins that archiving actually
    // engages it, which is the whole point of the status meaning something.
    const { templateId, v1Id } = await seedTemplate();
    await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/versions/${v1Id}/archive`)
      .send({ archived: true });

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/rollback`)
      .send({ versionId: v1Id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_PUBLISHED");
  });
});
