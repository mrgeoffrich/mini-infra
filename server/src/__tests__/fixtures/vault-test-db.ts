/**
 * Shared DB fixtures for the stack-vault integration test suite.
 *
 * Replaces the per-file `createEnv` / `createTestEnvironment`,
 * `createTemplateWithVault` / `createTemplateWithService`, and
 * `createBuiltinStack` / `createTestStack` / `createBoundStack` helpers that
 * had drifted into 4-5 near-identical variants.
 *
 * All helpers use the shared `testPrisma` from `integration-test-helpers.ts`
 * and `@paralleldrive/cuid2` for unique identifiers so parallel test runs do
 * not collide.
 */

import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "../integration-test-helpers";

export interface CreateTestStackTemplateOpts {
  /** Vault sections; pass `undefined` to leave the column null. */
  policies?: unknown[];
  appRoles?: unknown[];
  kv?: unknown[];
  inputs?: unknown[];
  /** Optional template service definitions with vault refs. */
  services?: Array<{
    serviceName: string;
    vaultAppRoleRef?: string;
    /** Defaults to "Stateful" if omitted. */
    serviceType?: string;
    /** Defaults to "nginx" if omitted. */
    dockerImage?: string;
    /** Defaults to "latest" if omitted. */
    dockerTag?: string;
  }>;
  /** Defaults to "system". Use "user" for user-template scenarios. */
  source?: "system" | "user";
}

/** Create a Cloudflare-tunnel-free `local` host environment. Returns the env id. */
export async function createTestEnvironment(): Promise<string> {
  const env = await testPrisma.environment.create({
    data: {
      id: createId(),
      name: `test-env-${createId().slice(0, 6)}`,
      type: "nonproduction",
      networkType: "local",
    },
  });
  return env.id;
}

/**
 * Create a stack template with a single published version. Returns
 * `templateId`, `version` (always 1), and `versionId` so callers can attach
 * downstream rows (e.g. `StackTemplateService`) when needed.
 */
export async function createTestStackTemplate(
  opts: CreateTestStackTemplateOpts = {},
): Promise<{ templateId: string; version: number; versionId: string }> {
  const templateId = createId();
  const versionId = createId();
  const source = opts.source ?? "system";

  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tmpl-${createId().slice(0, 8)}`,
      displayName: "Test Template",
      source,
      scope: "host",
      currentVersionId: null,
      draftVersionId: null,
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
      ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
      vaultPolicies: opts.policies ?? null,
      vaultAppRoles: opts.appRoles ?? null,
      ...(opts.kv !== undefined ? { vaultKv: opts.kv } : {}),
    },
  });

  if (opts.services && opts.services.length > 0) {
    for (const [i, svc] of opts.services.entries()) {
      await testPrisma.stackTemplateService.create({
        data: {
          id: createId(),
          versionId,
          serviceName: svc.serviceName,
          serviceType: svc.serviceType ?? "Stateful",
          dockerImage: svc.dockerImage ?? "nginx",
          dockerTag: svc.dockerTag ?? "latest",
          containerConfig: { restartPolicy: "unless-stopped" },
          dependsOn: [],
          order: i,
          ...(svc.vaultAppRoleRef !== undefined
            ? { vaultAppRoleRef: svc.vaultAppRoleRef }
            : {}),
        },
      });
    }
  }

  return { templateId, version: 1, versionId };
}

export interface CreateTestStackOpts {
  name?: string;
  templateId?: string;
  templateVersion?: number;
  environmentId?: string | null;
  encryptedInputValues?: string;
  /** Encrypted snapshot blob (pass via `encryptSnapshot()` or omit). */
  lastAppliedVaultSnapshot?: string | null;
  /** Per-service rows to attach. */
  services?: Array<{ serviceName: string; vaultAppRoleRef?: string | null }>;
  /** Tag this stack as a system/builtin stack so the builtin reconciler picks it up. */
  builtinVersion?: number | null;
}

/** Create a `Stack` row plus optional `StackService` rows. Returns the stack id. */
export async function createTestStack(opts: CreateTestStackOpts = {}): Promise<string> {
  const id = createId();
  await testPrisma.stack.create({
    data: {
      id,
      name: opts.name ?? `stack-${id.slice(0, 6)}`,
      networks: JSON.stringify([]),
      volumes: JSON.stringify([]),
      ...(opts.templateId !== undefined ? { templateId: opts.templateId } : {}),
      ...(opts.templateVersion !== undefined ? { templateVersion: opts.templateVersion } : {}),
      ...(opts.environmentId !== undefined ? { environmentId: opts.environmentId } : {}),
      ...(opts.encryptedInputValues !== undefined
        ? { encryptedInputValues: opts.encryptedInputValues }
        : {}),
      lastAppliedVaultSnapshot: opts.lastAppliedVaultSnapshot ?? null,
      ...(opts.builtinVersion !== undefined ? { builtinVersion: opts.builtinVersion } : {}),
    },
  });

  if (opts.services && opts.services.length > 0) {
    for (const [i, svc] of opts.services.entries()) {
      await testPrisma.stackService.create({
        data: {
          id: createId(),
          stackId: id,
          serviceName: svc.serviceName,
          serviceType: "Stateful",
          dockerImage: "myimage",
          dockerTag: "latest",
          containerConfig: JSON.stringify({ restartPolicy: "unless-stopped" }),
          dependsOn: JSON.stringify([]),
          order: i,
          vaultAppRoleRef: svc.vaultAppRoleRef ?? null,
        },
      });
    }
  }

  return id;
}
