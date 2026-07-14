/**
 * `Stack.templateVersionId` — the FK to the exact installed template version.
 *
 * The FK shipped alongside the upgrade primitive, and *only* the upgrade path
 * wrote it. Every other way a stack comes into being — instantiating a template,
 * the environment manager, the built-in stack sync — set the version *number* and
 * left the FK null. So a stack that was installed and never upgraded carried
 * `templateVersion: 1` with `templateVersionId: NULL`, which reads as "no version
 * installed" to anything needing the exact version rather than its number: a
 * targeted upgrade, or promoting a version from one environment to another.
 *
 * Nothing caught it because the number and the FK are only ever read separately.
 * These go through the HTTP route rather than a Prisma fixture, per the
 * field-persistence rule in server/CLAUDE.md — a fixture would happily set the
 * column the route forgets to.
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

async function seedPublishedTemplate(): Promise<{ templateId: string; versionId: string; version: number }> {
  const templateId = createId();
  const versionId = createId();
  const version = 1;

  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tpl-${templateId.slice(0, 6)}`,
      displayName: "Version FK template",
      source: "user",
      scope: "host",
    },
  });
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId,
      version,
      status: "published",
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      publishedAt: new Date(),
      services: {
        create: [
          {
            serviceName: "web",
            serviceType: "Stateful",
            dockerImage: "nginx",
            dockerTag: "1.25",
            containerConfig: {},
            dependsOn: [],
            order: 0,
          },
        ],
      },
    },
  });

  // Point the template at its published version only once that row exists — the
  // FK is real, and setting it on create would violate it.
  await testPrisma.stackTemplate.update({
    where: { id: templateId },
    data: { currentVersionId: versionId },
  });

  return { templateId, versionId, version };
}

describe("Stack.templateVersionId", () => {
  it("is set when a template is instantiated, not just when a stack is upgraded", async () => {
    const { templateId, versionId, version } = await seedPublishedTemplate();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/instantiate`)
      .send({ name: `stack-${createId().slice(0, 6)}` });

    expect(res.status).toBe(201);

    const stackId = res.body.data.id as string;
    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });

    expect(stack?.templateVersion).toBe(version);
    // The point of the test. Before the fix this was null on every freshly
    // installed stack, and promotion had nothing to promote.
    expect(stack?.templateVersionId).toBe(versionId);
  });

  it("reaches the client on the serialized stack, so promotion has a version to send", async () => {
    const { templateId, versionId } = await seedPublishedTemplate();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/instantiate`)
      .send({ name: `stack-${createId().slice(0, 6)}` });

    expect(res.status).toBe(201);
    // Serialized explicitly rather than riding the row spread, which only
    // survived on queries that used `include` over a narrowing `select`.
    expect(res.body.data.templateVersionId).toBe(versionId);
  });
});
