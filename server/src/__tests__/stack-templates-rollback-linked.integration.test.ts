/**
 * Integration tests for P2 template-version UX:
 *  - POST /api/stack-templates/:templateId/rollback — re-point currentVersion
 *    to an older published version (typed errors for 404/400/403).
 *  - GET /api/stack-templates/:templateId?includeLinkedStacks=true — the
 *    linked-stack serialization now carries templateVersion,
 *    templateCurrentVersion, and templateUpdateAvailable.
 */
import supertest from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { describe, it, expect } from "vitest";
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
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stack-templates", stackTemplateRouter);
  app.use(errorHandler);
  return app;
}

async function seedVersion(
  templateId: string,
  version: number,
  status: "published" | "draft",
): Promise<string> {
  const versionId = createId();
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId,
      version,
      status,
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      publishedAt: status === "published" ? new Date() : null,
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
  return versionId;
}

/** User template with v1+v2 published, currentVersion → v2. */
async function seedTemplate(source: "user" | "system" = "user"): Promise<{
  templateId: string;
  v1Id: string;
  v2Id: string;
}> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `rb-${templateId.slice(0, 6)}`,
      displayName: "Rollback Test",
      source,
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

describe("POST /api/stack-templates/:templateId/rollback", () => {
  it("re-points currentVersion to an older published version", async () => {
    const { templateId, v1Id } = await seedTemplate();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/rollback`)
      .send({ versionId: v1Id });

    expect(res.status).toBe(200);
    expect(res.body.data.currentVersionId).toBe(v1Id);
    expect(res.body.data.currentVersion.version).toBe(1);

    const template = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    expect(template?.currentVersionId).toBe(v1Id);
  });

  it("returns 404 for a version that doesn't belong to the template", async () => {
    const { templateId } = await seedTemplate();
    const other = await seedTemplate();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/rollback`)
      .send({ versionId: other.v1Id });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_FOUND");
  });

  it("returns 400 when the target version isn't published", async () => {
    const { templateId } = await seedTemplate();
    const draftId = await seedVersion(templateId, 3, "draft");

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/rollback`)
      .send({ versionId: draftId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_PUBLISHED");
  });

  it("returns 403 for a system template", async () => {
    const { templateId, v1Id } = await seedTemplate("system");

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/rollback`)
      .send({ versionId: v1Id });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("STACK_TEMPLATE_SYSTEM_IMMUTABLE");
  });
});

describe("GET /api/stack-templates/:templateId?includeLinkedStacks=true", () => {
  it("carries templateVersion/current/updateAvailable on linked stacks", async () => {
    const { templateId } = await seedTemplate(); // current = v2

    // Stack pinned to v1 → an update is available.
    const behindId = createId();
    await testPrisma.stack.create({
      data: {
        id: behindId,
        name: `behind-${behindId.slice(0, 6)}`,
        networks: [],
        volumes: [],
        templateId,
        templateVersion: 1,
        status: "synced",
      },
    });
    // Stack already on v2 → no update available.
    const currentId = createId();
    await testPrisma.stack.create({
      data: {
        id: currentId,
        name: `current-${currentId.slice(0, 6)}`,
        networks: [],
        volumes: [],
        templateId,
        templateVersion: 2,
        status: "synced",
      },
    });

    const res = await supertest(buildApp())
      .get(`/api/stack-templates/${templateId}?includeLinkedStacks=true`)
      .send();
    expect(res.status).toBe(200);

    const linked: Array<{
      id: string;
      templateVersion: number | null;
      templateCurrentVersion: number | null;
      templateUpdateAvailable: boolean;
    }> = res.body.data.linkedStacks;
    expect(linked).toHaveLength(2);

    const behind = linked.find((s) => s.id === behindId);
    expect(behind?.templateVersion).toBe(1);
    expect(behind?.templateCurrentVersion).toBe(2);
    expect(behind?.templateUpdateAvailable).toBe(true);

    const current = linked.find((s) => s.id === currentId);
    expect(current?.templateVersion).toBe(2);
    expect(current?.templateUpdateAvailable).toBe(false);
  });

  it("omits linkedStacks when the query flag is absent", async () => {
    const { templateId } = await seedTemplate();
    const res = await supertest(buildApp())
      .get(`/api/stack-templates/${templateId}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.data.linkedStacks).toBeUndefined();
  });
});
