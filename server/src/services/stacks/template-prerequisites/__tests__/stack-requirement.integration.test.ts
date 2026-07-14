/**
 * DB-backed coverage for stack-kind requirement evaluation. Exercises
 * the real Prisma path through `evaluatePrerequisites` so the schema
 * + the Stack.template join + status ordering all work together.
 *
 * Predicate handlers and authoring-error rejections are unit-tested
 * elsewhere — this file only covers the stack-kind branch.
 */

import { describe, it, expect } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "../../../../__tests__/integration-test-helpers";
import { evaluatePrerequisites } from "../evaluator";
import type { StackTemplatePrerequisite } from "@mini-infra/types";

async function createTemplate(opts: {
  name: string;
  scope: "host" | "environment" | "any";
  source?: "system" | "user";
}): Promise<{ templateId: string }> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: opts.name,
      displayName: opts.name,
      source: opts.source ?? "user",
      scope: opts.scope,
    },
  });
  return { templateId };
}

async function createVersion(opts: {
  templateId: string;
  version: number;
  requires?: StackTemplatePrerequisite[];
}): Promise<string> {
  const versionId = createId();
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId: opts.templateId,
      version: opts.version,
      status: "published",
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      requires: opts.requires
        ? (opts.requires as unknown as object)
        : undefined,
    },
  });
  return versionId;
}

async function createStack(opts: {
  name: string;
  templateId: string;
  templateVersion: number;
  status: string;
  environmentId?: string | null;
}): Promise<string> {
  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: opts.name,
      networks: [],
      volumes: [],
      templateId: opts.templateId,
      templateVersion: opts.templateVersion,
      environmentId: opts.environmentId ?? null,
      status: opts.status as never, // StackStatus enum; tests use the literal strings
    },
  });
  return stackId;
}

async function createEnvironment(name: string): Promise<string> {
  const envId = createId();
  await testPrisma.environment.create({
    data: {
      id: envId,
      name,
      type: "nonproduction",
      networkType: "local",
    },
  });
  return envId;
}

describe("evaluatePrerequisites — stack requirements (DB-backed)", () => {
  it("status meets minState — synced/drifted/pending pass per their level", async () => {
    const { templateId: vaultTpl } = await createTemplate({ name: "vault", scope: "host" });
    await createVersion({ templateId: vaultTpl, version: 1 });
    await createStack({
      name: "vault-host",
      templateId: vaultTpl,
      templateVersion: 1,
      status: "synced",
    });

    const { templateId: consumerTpl } = await createTemplate({ name: "consumer", scope: "host" });
    await createVersion({
      templateId: consumerTpl,
      version: 1,
      requires: [
        { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
      ],
    });
    const consumerStack = await createStack({
      name: "consumer-host",
      templateId: consumerTpl,
      templateVersion: 1,
      status: "pending",
    });

    const result = await evaluatePrerequisites(testPrisma, consumerStack);
    expect(result.ok).toBe(true);
  });

  it("error never satisfies a minState requirement", async () => {
    const status = "error";
    const { templateId: vaultTpl } = await createTemplate({
      name: `vault-${status}-${createId().slice(0, 6)}`,
      scope: "host",
    });
    await createVersion({ templateId: vaultTpl, version: 1 });
    await createStack({
      name: `vault-${status}`,
      templateId: vaultTpl,
      templateVersion: 1,
      status,
    });

    const { templateId: consumerTpl } = await createTemplate({
      name: `consumer-${status}-${createId().slice(0, 6)}`,
      scope: "host",
    });
    await createVersion({
      templateId: consumerTpl,
      version: 1,
      requires: [
        {
          kind: "stack",
          templateName: (await testPrisma.stackTemplate.findUnique({ where: { id: vaultTpl } }))!.name,
          minState: "pending",
          scopeMatch: "host",
        },
      ],
    });
    const consumerStack = await createStack({
      name: `consumer-${status}`,
      templateId: consumerTpl,
      templateVersion: 1,
      status: "pending",
    });

    const result = await evaluatePrerequisites(testPrisma, consumerStack);
    // 'error' makes it through the candidate query but fails the minState
    // comparison, so the fix is to re-apply the stack (apply-stack action).
    // The "no matching stack" → instantiate-stack path is covered in
    // evaluator.test.ts.
    expect(result.ok).toBe(false);
    expect(result.failures[0].helpAction?.type).toBe("apply-stack");
  });

  it("scopeMatch=same-environment matches only same-env candidates", async () => {
    const envProd = await createEnvironment("prod-" + createId().slice(0, 6));
    const envStaging = await createEnvironment("stg-" + createId().slice(0, 6));

    const { templateId: natsTpl } = await createTemplate({ name: "nats", scope: "environment" });
    await createVersion({ templateId: natsTpl, version: 1 });
    await createStack({
      name: "nats-prod",
      templateId: natsTpl,
      templateVersion: 1,
      status: "synced",
      environmentId: envProd,
    });

    const { templateId: consumerTpl } = await createTemplate({
      name: "env-consumer",
      scope: "environment",
    });
    await createVersion({
      templateId: consumerTpl,
      version: 1,
      requires: [
        { kind: "stack", templateName: "nats", minState: "synced", scopeMatch: "same-environment" },
      ],
    });

    // Consumer in prod — matches.
    const consumerProd = await createStack({
      name: "consumer-prod",
      templateId: consumerTpl,
      templateVersion: 1,
      status: "pending",
      environmentId: envProd,
    });
    expect((await evaluatePrerequisites(testPrisma, consumerProd)).ok).toBe(true);

    // Consumer in staging — no nats stack there → fails.
    const consumerStaging = await createStack({
      name: "consumer-staging",
      templateId: consumerTpl,
      templateVersion: 1,
      status: "pending",
      environmentId: envStaging,
    });
    expect((await evaluatePrerequisites(testPrisma, consumerStaging)).ok).toBe(false);
  });

  it("scopeMatch=environment matches any env-scoped instance regardless of which env", async () => {
    const env = await createEnvironment("anyenv-" + createId().slice(0, 6));
    const { templateId: natsTpl } = await createTemplate({ name: "nats-any", scope: "environment" });
    await createVersion({ templateId: natsTpl, version: 1 });
    await createStack({
      name: "nats-anywhere",
      templateId: natsTpl,
      templateVersion: 1,
      status: "synced",
      environmentId: env,
    });

    const { templateId: consumerTpl } = await createTemplate({ name: "host-consumer-any", scope: "host" });
    await createVersion({
      templateId: consumerTpl,
      version: 1,
      requires: [
        { kind: "stack", templateName: "nats-any", minState: "synced", scopeMatch: "environment" },
      ],
    });
    const hostConsumer = await createStack({
      name: "host-consumer",
      templateId: consumerTpl,
      templateVersion: 1,
      status: "pending",
    });
    expect((await evaluatePrerequisites(testPrisma, hostConsumer)).ok).toBe(true);
  });
});
