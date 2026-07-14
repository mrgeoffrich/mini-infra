/**
 * Unit tests for the prerequisites evaluator. Stubs Prisma and the
 * predicate registry — DB-backed coverage of stack-kind requirements
 * lives in `stack-requirement.test.ts`, predicate behaviour in
 * `vault-bootstrapped.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The predicate registry is module-level state — replace it before
// importing the evaluator so getPredicate() returns our stub.
vi.mock("../predicates", () => {
  const handlers: Record<string, () => Promise<{ ok: boolean; reason?: string }>> = {};
  return {
    getPredicate: vi.fn((name: string) => handlers[name]),
    isKnownPredicate: vi.fn((name: string) =>
      Object.prototype.hasOwnProperty.call(handlers, name),
    ),
    listPredicateNames: vi.fn(() => Object.keys(handlers)),
    __setPredicate: (name: string, fn: () => Promise<{ ok: boolean; reason?: string }>) => {
      handlers[name] = fn;
    },
    __resetPredicates: () => {
      for (const k of Object.keys(handlers)) delete handlers[k];
    },
  };
});

import {
  evaluatePrerequisites,
  evaluatePrerequisitesForTemplateVersion,
} from "../evaluator";
import * as predicateRegistry from "../predicates";

const predicateMock = predicateRegistry as unknown as {
  __setPredicate: (
    name: string,
    fn: () => Promise<{ ok: boolean; reason?: string }>,
  ) => void;
  __resetPredicates: () => void;
};

import type { StackTemplatePrerequisite } from "@mini-infra/types";

// =====================================================================
// Test doubles for Prisma. Only the methods/fields the evaluator
// actually reads need stubs.
// =====================================================================

interface FakeStackRow {
  id: string;
  environmentId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  status?: string;
  template?: { scope: string };
}

interface FakeVersionRow {
  id: string;
  templateId: string;
  version: number;
  requires: StackTemplatePrerequisite[] | null;
}

function buildFakePrisma(opts: {
  stacks: FakeStackRow[];
  versions: FakeVersionRow[];
}) {
  return {
    stack: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        return opts.stacks.find((s) => s.id === id) ?? null;
      },
      findMany: async ({
        where,
      }: {
        where: { template?: { name: string } };
      }) => {
        // Phase 1 evaluator only filters by template.name.
        const targetName = where.template?.name;
        return opts.stacks
          .filter((s) => s.templateId !== null)
          .filter((s) => {
            if (!targetName) return true;
            // Look up the template scope/name via a parallel array.
            return s.template !== undefined && (s.template as unknown as { name?: string }).name === targetName;
          })
          .map((s) => ({
            id: s.id,
            status: s.status ?? "synced",
            environmentId: s.environmentId,
            template: s.template ?? null,
          }));
      },
    },
    stackTemplateVersion: {
      findUnique: async ({
        where: { id },
      }: {
        where: { id: string };
      }) => opts.versions.find((v) => v.id === id) ?? null,
      findFirst: async ({
        where: { templateId, version },
      }: {
        where: { templateId: string; version: number };
      }) =>
        opts.versions.find(
          (v) => v.templateId === templateId && v.version === version,
        ) ?? null,
    },
  } as unknown as Parameters<typeof evaluatePrerequisites>[0];
}

// Helper: construct a stack with a template-name shortcut for findMany.
function stack(opts: {
  id: string;
  templateName: string | null;
  templateScope: "host" | "environment" | "any";
  environmentId: string | null;
  status: string;
  templateId?: string;
  templateVersion?: number;
}): FakeStackRow {
  if (opts.templateName === null) {
    return {
      id: opts.id,
      environmentId: opts.environmentId,
      templateId: null,
      templateVersion: null,
      status: opts.status,
    };
  }
  return {
    id: opts.id,
    environmentId: opts.environmentId,
    templateId: opts.templateId ?? `tmpl-${opts.templateName}`,
    templateVersion: opts.templateVersion ?? 1,
    status: opts.status,
    template: { scope: opts.templateScope, name: opts.templateName } as unknown as { scope: string },
  };
}

// =====================================================================

describe("evaluatePrerequisites — stack-kind requirements", () => {
  beforeEach(() => {
    predicateMock.__resetPredicates();
  });

  it("returns ok when the stack has no template binding", async () => {
    const prisma = buildFakePrisma({
      stacks: [stack({ id: "s1", templateName: null, templateScope: "host", environmentId: null, status: "pending" })],
      versions: [],
    });
    const result = await evaluatePrerequisites(prisma, "s1");
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("returns ok when requires is empty/null", async () => {
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "s1",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
      ],
      versions: [
        { id: "v1", templateId: "tmpl-consumer", version: 1, requires: null },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "s1");
    expect(result.ok).toBe(true);
  });

  it("passes when a host-scoped requirement is satisfied", async () => {
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "consumer",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
        stack({
          id: "vault",
          templateName: "vault",
          templateScope: "host",
          environmentId: null,
          status: "synced",
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [
            { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
          ],
        },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "consumer");
    expect(result.ok).toBe(true);
  });

  it("fails with 'instantiate-stack' helpAction when no matching stack exists", async () => {
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "consumer",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [
            { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
          ],
        },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "consumer");
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].helpAction).toEqual({
      type: "instantiate-stack",
      templateName: "vault",
      scopeMatch: "host",
    });
  });

  it("fails with 'apply-stack' helpAction when matching stack is below minState", async () => {
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "consumer",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
        stack({
          id: "vault",
          templateName: "vault",
          templateScope: "host",
          environmentId: null,
          status: "undeployed",
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [
            { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
          ],
        },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "consumer");
    expect(result.ok).toBe(false);
    expect(result.failures[0].helpAction).toEqual({
      type: "apply-stack",
      templateName: "vault",
      scopeMatch: "host",
    });
    expect(result.failures[0].detail?.observedStatus).toBe("undeployed");
  });

  it("collects mixed pass/fail — only failures appear in result", async () => {
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "consumer",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
        stack({
          id: "vault",
          templateName: "vault",
          templateScope: "host",
          environmentId: null,
          status: "synced",
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [
            { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
            { kind: "stack", templateName: "missing", minState: "synced", scopeMatch: "host" },
          ],
        },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "consumer");
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].detail?.templateName).toBe("missing");
  });

  it("throws when a same-environment requirement runs against a host-scoped stack", async () => {
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "host-stack",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [
            {
              kind: "stack",
              templateName: "nats",
              minState: "synced",
              scopeMatch: "same-environment",
            },
          ],
        },
      ],
    });
    await expect(evaluatePrerequisites(prisma, "host-stack")).rejects.toThrow(
      /same-environment/,
    );
  });
});

describe("evaluatePrerequisites — predicate-kind requirements", () => {
  beforeEach(() => {
    predicateMock.__resetPredicates();
  });

  it("passes when the predicate returns ok: true", async () => {
    predicateMock.__setPredicate("vault-bootstrapped", async () => ({ ok: true }));
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "consumer",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [{ kind: "predicate", name: "vault-bootstrapped" }],
        },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "consumer");
    expect(result.ok).toBe(true);
  });

  it("propagates predicate reason + helpAction to the failure", async () => {
    predicateMock.__setPredicate("vault-bootstrapped", async () => ({
      ok: false,
      reason: "Vault has not been bootstrapped yet",
      helpAction: { type: "open-vault-bootstrap" as const },
    }));
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "consumer",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [{ kind: "predicate", name: "vault-bootstrapped" }],
        },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "consumer");
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("predicate");
    expect(result.failures[0].reason).toContain("bootstrapped");
    expect(result.failures[0].helpAction).toEqual({ type: "open-vault-bootstrap" });
  });

  it("emits a failure when the predicate name is unknown at evaluate time", async () => {
    // Empty registry — predicate `mystery` not registered.
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "consumer",
          templateName: "consumer",
          templateScope: "host",
          environmentId: null,
          status: "pending",
          templateId: "tmpl-consumer",
          templateVersion: 1,
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "tmpl-consumer",
          version: 1,
          requires: [{ kind: "predicate", name: "mystery" }],
        },
      ],
    });
    const result = await evaluatePrerequisites(prisma, "consumer");
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain("Unknown predicate");
  });
});

describe("evaluatePrerequisitesForTemplateVersion", () => {
  beforeEach(() => {
    predicateMock.__resetPredicates();
  });

  it("returns ok for a version with empty requires", async () => {
    const prisma = buildFakePrisma({
      stacks: [],
      versions: [
        { id: "v1", templateId: "t1", version: 1, requires: null },
      ],
    });
    const result = await evaluatePrerequisitesForTemplateVersion(prisma, "v1", { kind: "host" });
    expect(result.ok).toBe(true);
  });

  it("evaluates against the supplied scope (env vs host)", async () => {
    const prisma = buildFakePrisma({
      stacks: [
        stack({
          id: "nats-prod",
          templateName: "nats",
          templateScope: "environment",
          environmentId: "env-prod",
          status: "synced",
        }),
      ],
      versions: [
        {
          id: "v1",
          templateId: "t1",
          version: 1,
          requires: [
            { kind: "stack", templateName: "nats", minState: "synced", scopeMatch: "same-environment" },
          ],
        },
      ],
    });
    const okEnv = await evaluatePrerequisitesForTemplateVersion(prisma, "v1", {
      kind: "environment",
      environmentId: "env-prod",
    });
    expect(okEnv.ok).toBe(true);

    const wrongEnv = await evaluatePrerequisitesForTemplateVersion(prisma, "v1", {
      kind: "environment",
      environmentId: "env-staging",
    });
    expect(wrongEnv.ok).toBe(false);
  });

  it("throws if the requested template version doesn't exist", async () => {
    const prisma = buildFakePrisma({ stacks: [], versions: [] });
    await expect(
      evaluatePrerequisitesForTemplateVersion(prisma, "missing", { kind: "host" }),
    ).rejects.toThrow(/not found/);
  });
});
