/**
 * Integration test for the soft-archive path (P0 item 5).
 *
 * The template list's "Archive" action now drives PATCH /:templateId with
 * `{ isArchived: true }` — a real soft-archive that hides the template from the
 * default list while leaving its linked stacks completely untouched. This is
 * distinct from DELETE, which tears the template and its stacks down.
 *
 * System templates remain immutable through this path (same guard as the rest
 * of updateTemplateMeta).
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

async function createTemplate(source: "user" | "system"): Promise<string> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `archive-test-${templateId.slice(0, 6)}`,
      displayName: "Archive Test",
      source,
      scope: "host",
    },
  });
  return templateId;
}

describe("PATCH /api/stack-templates/:templateId — soft archive", () => {
  it("sets isArchived:true without touching linked stacks", async () => {
    const templateId = await createTemplate("user");
    const stackId = createId();
    await testPrisma.stack.create({
      data: {
        id: stackId,
        name: `linked-${stackId.slice(0, 6)}`,
        networks: [],
        volumes: [],
        templateId,
        templateVersion: 1,
        status: "synced",
      },
    });

    const res = await supertest(buildApp())
      .patch(`/api/stack-templates/${templateId}`)
      .send({ isArchived: true });

    expect(res.status).toBe(200);
    expect(res.body.data.isArchived).toBe(true);

    const row = await testPrisma.stackTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(row.isArchived).toBe(true);

    // The linked stack is untouched — archive is not delete.
    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(stack).not.toBeNull();
    expect(stack?.status).toBe("synced");
  });

  it("unarchives (isArchived:false) when toggled back", async () => {
    const templateId = await createTemplate("user");
    await testPrisma.stackTemplate.update({
      where: { id: templateId },
      data: { isArchived: true },
    });

    const res = await supertest(buildApp())
      .patch(`/api/stack-templates/${templateId}`)
      .send({ isArchived: false });

    expect(res.status).toBe(200);
    expect(res.body.data.isArchived).toBe(false);

    const row = await testPrisma.stackTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(row.isArchived).toBe(false);
  });

  it("leaves other metadata untouched when only isArchived is sent", async () => {
    const templateId = await createTemplate("user");

    const res = await supertest(buildApp())
      .patch(`/api/stack-templates/${templateId}`)
      .send({ isArchived: true });

    expect(res.status).toBe(200);
    const row = await testPrisma.stackTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(row.displayName).toBe("Archive Test");
  });

  it("rejects archiving a system template with 403", async () => {
    const templateId = await createTemplate("system");

    const res = await supertest(buildApp())
      .patch(`/api/stack-templates/${templateId}`)
      .send({ isArchived: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("STACK_TEMPLATE_SYSTEM_IMMUTABLE");

    const row = await testPrisma.stackTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(row.isArchived).toBe(false);
  });
});
