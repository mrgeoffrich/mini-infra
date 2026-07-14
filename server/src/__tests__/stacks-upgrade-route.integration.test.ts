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
      status: "published",
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
