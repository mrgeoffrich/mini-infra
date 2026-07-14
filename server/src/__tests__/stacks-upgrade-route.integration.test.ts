/**
 * Integration test for POST /api/stacks/:stackId/upgrade (P1 item 7).
 *
 * Upgrade re-materializes a stack from its template's current published version,
 * merging the operator's existing parameter values over the new defaults and
 * merging input values (honouring rotateOnUpgrade). It does NOT apply.
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

import stacksUpgradeRoute from "../routes/stacks/stacks-upgrade-route";
import { stackOperationLock } from "../services/stacks/operation-lock";
import {
  encryptInputValues,
  decryptInputValues,
} from "../services/stacks/stack-input-values-service";
import { errorHandler } from "../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/stacks", stacksUpgradeRoute);
  app.use(errorHandler);
  return app;
}

interface SeedVersionInput {
  version: number;
  parameters: Array<{ name: string; default: string }>;
  services: Array<{ serviceName: string; dockerTag: string }>;
  inputs?: Array<{ name: string; rotateOnUpgrade: boolean }>;
  /** Defaults to `published`. `draft`/`archived` exercise the target-version guard. */
  status?: "draft" | "published" | "archived";
}

async function seedTemplateVersion(templateId: string, v: SeedVersionInput): Promise<string> {
  const versionId = createId();
  const defaultParameterValues: Record<string, string> = {};
  for (const p of v.parameters) defaultParameterValues[p.name] = p.default;
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId,
      version: v.version,
      status: v.status ?? "published",
      parameters: v.parameters.map((p) => ({
        name: p.name,
        type: "string",
        default: p.default,
        required: false,
      })),
      defaultParameterValues,
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      inputs: v.inputs
        ? v.inputs.map((i) => ({
            name: i.name,
            sensitive: true,
            required: false,
            rotateOnUpgrade: i.rotateOnUpgrade,
          }))
        : undefined,
      publishedAt: new Date(),
      services: {
        create: v.services.map((s, i) => ({
          serviceName: s.serviceName,
          serviceType: "Stateful",
          dockerImage: "nginx",
          dockerTag: s.dockerTag,
          containerConfig: {},
          dependsOn: [],
          order: i,
        })),
      },
    },
  });
  return versionId;
}

/** Creates a user template with v1 + v2 published; currentVersion → v2. */
async function seedTemplateWithTwoVersions(): Promise<{
  templateId: string;
  v1Id: string;
  v2Id: string;
}> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: "upg-tpl-" + templateId.slice(0, 6),
      displayName: "Upgrade Template",
      source: "user",
      scope: "any",
    },
  });
  const v1Id = await seedTemplateVersion(templateId, {
    version: 1,
    parameters: [
      { name: "replicas", default: "1" },
      { name: "region", default: "us" },
    ],
    services: [{ serviceName: "web", dockerTag: "1.0" }],
    inputs: [{ name: "apiKey", rotateOnUpgrade: false }],
  });
  const v2Id = await seedTemplateVersion(templateId, {
    version: 2,
    parameters: [
      { name: "replicas", default: "1" },
      { name: "region", default: "us" },
      { name: "tier", default: "free" },
    ],
    services: [
      { serviceName: "web", dockerTag: "2.0" },
      { serviceName: "worker", dockerTag: "2.0" },
    ],
    inputs: [
      { name: "apiKey", rotateOnUpgrade: false },
      { name: "token", rotateOnUpgrade: true },
    ],
  });
  await testPrisma.stackTemplate.update({
    where: { id: templateId },
    data: { currentVersionId: v2Id },
  });
  return { templateId, v1Id, v2Id };
}

async function seedStackOnVersion(opts: {
  templateId: string;
  templateVersion: number;
  templateVersionId: string;
  parameterValues?: Record<string, string>;
  inputValues?: Record<string, string>;
}): Promise<string> {
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: "upg-stack-" + stackId.slice(0, 6),
      networks: [],
      volumes: [],
      status: "synced",
      version: 3,
      templateId: opts.templateId,
      templateVersion: opts.templateVersion,
      templateVersionId: opts.templateVersionId,
      parameterValues: opts.parameterValues ?? {},
      encryptedInputValues: opts.inputValues
        ? encryptInputValues(opts.inputValues)
        : undefined,
      services: {
        create: [
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
    },
  });
  return stackId;
}

describe("POST /api/stacks/:stackId/upgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-materializes from the current version, merging params, and sets pending", async () => {
    const { templateId, v1Id, v2Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
      parameterValues: { replicas: "3" }, // operator override to preserve
      inputValues: { apiKey: "stored-key" },
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      // v2 adds a rotateOnUpgrade `token` input — must be supplied on upgrade.
      .send({ inputValues: { token: "rotated" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("pending");
    expect(res.body.data.templateVersion).toBe(2);
    expect(res.body.data.version).toBe(4); // bumped from 3

    const stack = await testPrisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });
    // FK pinned to the exact v2 row.
    expect(stack?.templateVersionId).toBe(v2Id);
    // Services re-materialized from v2 (web@2.0 + new worker).
    const svcNames = stack?.services.map((s) => s.serviceName).sort();
    expect(svcNames).toEqual(["web", "worker"]);
    const web = stack?.services.find((s) => s.serviceName === "web");
    expect(web?.dockerTag).toBe("2.0");
    // Params: operator override preserved, new v2 param defaulted.
    const params = stack?.parameterValues as Record<string, string>;
    expect(params.replicas).toBe("3");
    expect(params.region).toBe("us");
    expect(params.tier).toBe("free");
  });

  it("preserves non-rotating inputs and requires rotateOnUpgrade inputs", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
      inputValues: { apiKey: "stored-key", token: "old-token" },
    });

    // Missing the rotateOnUpgrade `token` → 400.
    const missing = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ inputValues: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("STACK_INPUT_ROTATION_REQUIRED");

    // Supplying the token succeeds; apiKey is preserved from storage.
    const ok = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ inputValues: { token: "new-token" } });
    expect(ok.status).toBe(200);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    const decrypted = decryptInputValues(stack!.encryptedInputValues!);
    expect(decrypted.apiKey).toBe("stored-key");
    expect(decrypted.token).toBe("new-token");
  });

  it("returns 400 STACK_NO_TEMPLATE for a stack without a template", async () => {
    const stackId = createId();
    await testPrisma.stack.create({
      data: {
        id: stackId,
        name: "no-tpl-" + stackId.slice(0, 6),
        networks: [],
        volumes: [],
        status: "synced",
      },
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_NO_TEMPLATE");
  });

  it("returns 409 STACK_ALREADY_ON_LATEST when already on the current version", async () => {
    const { templateId, v2Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 2, // already on current
      templateVersionId: v2Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("STACK_ALREADY_ON_LATEST");
    expect(res.body.message).toContain("already on the latest");
  });

  it("tells a stack stranded ahead by a rollback the truth, not 'already on latest'", async () => {
    // After a template rollback the stack can sit on a version NEWER than the
    // template's current one. An UNtargeted upgrade is still refused — silently
    // downgrading a stack because the template moved under it would be a nasty
    // surprise — but telling a stack on v3 that it is "already on the latest
    // version (v2)" is simply false, and hides the fact that a rollback stranded
    // it. The way out is naming a version explicitly (see the targeted tests).
    const { templateId, v2Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 3, // ahead of the template's current version (v2)
      templateVersionId: v2Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("STACK_ALREADY_ON_LATEST");
    expect(res.body.message).toContain("newer than the template's current version");
    expect(res.body.message).toContain("rolled back");
    expect(res.body.message).not.toContain("already on the latest");
  });

  it("returns 409 when an operation is already in progress", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });
    stackOperationLock.tryAcquire(stackId);
    try {
      const res = await supertest(buildApp())
        .post(`/api/stacks/${stackId}/upgrade`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("STACK_OPERATION_IN_PROGRESS");
    } finally {
      stackOperationLock.release(stackId);
    }
  });

  it("returns 404 for an unknown stack", async () => {
    const res = await supertest(buildApp())
      .post(`/api/stacks/${createId()}/upgrade`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/stacks/:stackId/upgrade — targetVersionId (P4 4.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downgrades to an older published version, re-materializing its services", async () => {
    const { templateId, v1Id, v2Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 2, // on current
      templateVersionId: v2Id,
      parameterValues: { replicas: "3" },
      inputValues: { apiKey: "stored-key" },
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ targetVersionId: v1Id });
    expect(res.status).toBe(200);
    expect(res.body.data.templateVersion).toBe(1);
    expect(res.body.data.status).toBe("pending");

    const stack = await testPrisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });
    expect(stack?.templateVersionId).toBe(v1Id);
    // v1 has only `web` at 1.0 — v2's `worker` must be gone, not left behind.
    expect(stack?.services.map((s) => s.serviceName)).toEqual(["web"]);
    expect(stack?.services[0]?.dockerTag).toBe("1.0");
    // Operator's parameter override survives a downgrade too.
    expect((stack?.parameterValues as Record<string, string>).replicas).toBe("3");
  });

  it("lets a stack stranded ahead by a rollback move back to the current version", async () => {
    // The scenario the untargeted path can only complain about: template rolled
    // back to v1, stack still on v2. Naming v1 explicitly is the way out.
    const { templateId, v1Id, v2Id } = await seedTemplateWithTwoVersions();
    await testPrisma.stackTemplate.update({
      where: { id: templateId },
      data: { currentVersionId: v1Id }, // the rollback
    });
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 2,
      templateVersionId: v2Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ targetVersionId: v1Id });
    expect(res.status).toBe(200);
    expect(res.body.data.templateVersion).toBe(1);
  });

  it("rejects a draft target with 400 STACK_TEMPLATE_VERSION_NOT_PUBLISHED", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const draftId = await seedTemplateVersion(templateId, {
      version: 3,
      status: "draft",
      parameters: [],
      services: [{ serviceName: "web", dockerTag: "3.0" }],
    });
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ targetVersionId: draftId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_PUBLISHED");
  });

  it("rejects an archived target with 400 STACK_TEMPLATE_VERSION_NOT_PUBLISHED", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const archivedId = await seedTemplateVersion(templateId, {
      version: 4,
      status: "archived",
      parameters: [],
      services: [{ serviceName: "web", dockerTag: "4.0" }],
    });
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ targetVersionId: archivedId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_PUBLISHED");
  });

  it("rejects a version belonging to another template with 404", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const other = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      // A real, published version — but of a DIFFERENT template.
      .send({ targetVersionId: other.v2Id });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_FOUND");
  });

  it("returns 404 for an unknown targetVersionId", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ targetVersionId: createId() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_FOUND");
  });

  it("409s when the target is the version already installed", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });

    const res = await supertest(buildApp())
      .post(`/api/stacks/${stackId}/upgrade`)
      .send({ targetVersionId: v1Id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("STACK_ALREADY_ON_LATEST");
    // "already on the LATEST" would be a lie: v1 is not the latest, it is just
    // the one they asked for and already have.
    expect(res.body.message).toContain("already on template version v1");
    expect(res.body.message).not.toContain("latest");
  });
});

describe("GET /api/stacks/:stackId/upgrade-inputs — targetVersionId (P4 4.2)", () => {
  it("reads rotateOnUpgrade inputs off the TARGET version, not the current one", async () => {
    const { templateId, v1Id, v2Id } = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });

    // No target → the current version (v2), which declares a rotating `token`.
    const current = await supertest(buildApp()).get(`/api/stacks/${stackId}/upgrade-inputs`);
    expect(current.status).toBe(200);
    expect(current.body.data.inputs.map((i: { name: string }) => i.name)).toEqual(["token"]);

    // Targeting v1 — whose only input does NOT rotate — must return nothing.
    // Resolving against currentVersion regardless would prompt the operator to
    // rotate a secret the version they are deploying doesn't even declare.
    const targeted = await supertest(buildApp())
      .get(`/api/stacks/${stackId}/upgrade-inputs`)
      .query({ targetVersionId: v1Id });
    expect(targeted.status).toBe(200);
    expect(targeted.body.data.inputs).toEqual([]);

    // Sanity: explicitly targeting v2 matches the untargeted answer.
    const targetedV2 = await supertest(buildApp())
      .get(`/api/stacks/${stackId}/upgrade-inputs`)
      .query({ targetVersionId: v2Id });
    expect(targetedV2.body.data.inputs.map((i: { name: string }) => i.name)).toEqual(["token"]);
  });

  it("404s when the target version belongs to another template", async () => {
    const { templateId, v1Id } = await seedTemplateWithTwoVersions();
    const other = await seedTemplateWithTwoVersions();
    const stackId = await seedStackOnVersion({
      templateId,
      templateVersion: 1,
      templateVersionId: v1Id,
    });

    const res = await supertest(buildApp())
      .get(`/api/stacks/${stackId}/upgrade-inputs`)
      .query({ targetVersionId: other.v2Id });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("STACK_TEMPLATE_VERSION_NOT_FOUND");
  });
});
