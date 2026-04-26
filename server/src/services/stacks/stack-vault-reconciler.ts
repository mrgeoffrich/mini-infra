/**
 * Pre-service Vault reconciliation phase for stack apply.
 *
 * Runs before the existing container reconcile loop. Templates with a non-empty
 * `vault: { policies, appRoles, kv }` section have those resources upserted into
 * Vault. Each sub-phase is skipped entirely when no items are declared; skipping is
 * also applied per-item using content hashes against the last applied snapshot for
 * idempotency.
 *
 * Pipeline:
 *   1. Decrypt encryptedInputValues → verify all required non-rotateOnUpgrade have values
 *   2. Build template context (substitutes {{stack.id}}, {{environment.*}}, {{inputs.*}})
 *   3. Policies  — render name + body, hash, upsert+publish
 *   4. AppRoles  — render name, resolve policy, upsert+apply, record concrete ID
 *   5. KV        — render path (re-validate), resolve fromInput, hash, write
 *   6. Persist lastAppliedVaultSnapshot; return appliedAppRoleIdByName
 */

import crypto from "crypto";
import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { decryptInputValues } from "./stack-input-values-service";
import {
  buildTemplateContext,
  resolveTemplate,
  type TemplateContext,
  type TemplateContextEnvironment,
} from "./template-engine";
import { validateKvPath } from "../vault/vault-kv-paths";
import { UserEventService } from "../user-events/user-event-service";
import type {
  TemplateInputDeclaration,
  TemplateVaultAppRole,
  TemplateVaultKv,
  TemplateVaultPolicy,
} from "@mini-infra/types";

const log = getLogger("stacks", "stack-vault-reconciler");

// =====================
// Public types
// =====================

export interface StackVaultReconcilerInput {
  stackId: string;
  templateVersion: number;
  inputs: TemplateInputDeclaration[];
  vault: {
    policies?: TemplateVaultPolicy[];
    appRoles?: TemplateVaultAppRole[];
    kv?: TemplateVaultKv[];
  };
  userId: string | undefined;
}

export type VaultReconcileStatus = "applied" | "noop" | "error";

export interface StackVaultReconcileResult {
  status: VaultReconcileStatus;
  /** Mapping from template appRole name → concrete DB AppRole ID. */
  appliedAppRoleIdByName: Record<string, string>;
  error?: string;
}

// =====================
// Internal helpers
// =====================

/** SHA-256 of an arbitrary string — used for content-hash idempotency. */
function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Lazy-import Vault services inside the function body to avoid pulling the
 * full Vault wiring into unit tests that don't need it.
 */
async function getVaultPolicyService(prisma: PrismaClient) {
  const { VaultPolicyService } = await import("../vault/vault-policy-service");
  const { getVaultServices } = await import("../vault/vault-services");
  return new VaultPolicyService(prisma, getVaultServices().admin);
}

async function getVaultAppRoleService(prisma: PrismaClient) {
  const { VaultAppRoleService } = await import("../vault/vault-approle-service");
  const { getVaultServices } = await import("../vault/vault-services");
  return new VaultAppRoleService(prisma, getVaultServices().admin);
}

async function getVaultKVSvc() {
  const { getVaultKVService } = await import("../vault/vault-kv-service");
  return getVaultKVService();
}

/** Build a Vault-safe lowercase-alphanumeric-hyphen name from a template-rendered string. */
function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Render a policy/appRole name through the template context. Keeps the raw
 * name if it has no template tokens.
 */
function renderName(template: string, ctx: TemplateContext): string {
  if (!template.includes("{{")) return template;
  return resolveTemplate(template, ctx);
}

/** Emit a UserEvent row for an individual Vault mutation. Non-fatal on failure. */
async function emitVaultEvent(
  svc: UserEventService,
  eventType: "stack_vault_policy_apply" | "stack_vault_approle_apply" | "stack_vault_kv_apply",
  triggeredBy: string,
  status: "completed" | "noop" | "failed",
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await svc.createEvent({
      eventType,
      eventCategory: "security",
      eventName: `${eventType}: ${metadata.concreteName ?? metadata.concretePath ?? ""}`,
      triggeredBy,
      status: status === "noop" ? "completed" : status,
      progress: status === "failed" ? 0 : 100,
      resourceType: "stack",
      description:
        status === "noop"
          ? `Skipped (no change) — ${eventType}`
          : status === "failed"
            ? `Failed — ${eventType}`
            : `Applied — ${eventType}`,
      metadata: { ...metadata, action: status },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), eventType },
      "Failed to emit vault audit event (non-fatal)",
    );
  }
}

// =====================
// Snapshot shape
// =====================

interface VaultSnapshotPhase {
  /** concreteName/path → content hash */
  hashes: Record<string, string>;
}

interface VaultApplySnapshot {
  policies: VaultSnapshotPhase;
  appRoles: VaultSnapshotPhase;
  kv: VaultSnapshotPhase;
}

function emptySnapshot(): VaultApplySnapshot {
  return {
    policies: { hashes: {} },
    appRoles: { hashes: {} },
    kv: { hashes: {} },
  };
}

// =====================
// Public entry point
// =====================

/**
 * Run the Vault pre-service reconciliation phase for a stack apply.
 *
 * Accepts injected service factories for testability. In production the
 * defaults use the singleton Vault services. Pass overrides in tests to avoid
 * live Vault connections.
 */
export async function runStackVaultReconciler(
  prisma: PrismaClient,
  stackId: string,
  input: StackVaultReconcilerInput,
  services?: {
    getPolicyService?: (prisma: PrismaClient) => Promise<PolicyServiceFacade>;
    getAppRoleService?: (prisma: PrismaClient) => Promise<AppRoleServiceFacade>;
    getKVService?: () => Promise<KVServiceFacade>;
  },
): Promise<StackVaultReconcileResult> {
  const { templateVersion, inputs, vault, userId } = input;

  const policies = vault.policies ?? [];
  const appRoles = vault.appRoles ?? [];
  const kvEntries = vault.kv ?? [];

  const triggeredBy = `stack-apply:${stackId}:v${templateVersion}`;

  // Load current snapshot (null if first apply)
  const stackRow = await prisma.stack.findUniqueOrThrow({
    where: { id: stackId },
    select: {
      encryptedInputValues: true,
      lastAppliedVaultSnapshot: true,
      name: true,
      environmentId: true,
      networks: true,
      volumes: true,
      parameterValues: true,
      parameters: true,
    },
  });

  // 1. Decrypt input values and verify completeness
  const decryptedInputs = stackRow.encryptedInputValues
    ? decryptInputValues(stackRow.encryptedInputValues)
    : {};

  const missingRequired = inputs
    .filter((d) => d.required && !d.rotateOnUpgrade && !(d.name in decryptedInputs))
    .map((d) => d.name);
  if (missingRequired.length > 0) {
    return {
      status: "error",
      appliedAppRoleIdByName: {},
      error: `Missing required input values: ${missingRequired.join(", ")}`,
    };
  }

  // 2. Build template context including inputs namespace
  let environment: TemplateContextEnvironment | undefined;
  if (stackRow.environmentId) {
    const env = await prisma.environment.findUnique({
      where: { id: stackRow.environmentId },
      select: { id: true, name: true, type: true, networkType: true },
    });
    if (env) {
      environment = {
        id: env.id,
        name: env.name,
        type: env.type as TemplateContextEnvironment["type"],
        networkType: env.networkType as TemplateContextEnvironment["networkType"],
      };
    }
  }

  const templateCtx = buildTemplateContext(
    {
      name: stackRow.name,
      networks: (stackRow.networks as Array<{ name: string }>) ?? [],
      volumes: (stackRow.volumes as Array<{ name: string }>) ?? [],
    },
    [],
    {
      stackId,
      environment,
      inputs: decryptedInputs,
    },
  );

  const prevSnapshot = stackRow.lastAppliedVaultSnapshot
    ? (stackRow.lastAppliedVaultSnapshot as unknown as VaultApplySnapshot)
    : emptySnapshot();

  const newSnapshot = emptySnapshot();
  const appliedAppRoleIdByName: Record<string, string> = {};
  const userEventSvc = new UserEventService(prisma);
  let anyApplied = false;

  // =====================
  // 3. Policies
  // =====================
  /** concreteName → DB id, built as we upsert so AppRoles can reference it */
  const policyIdByConcreteName: Record<string, string> = {};

  // Load lazily so tests that pass an empty vault section don't exercise the service factory
  const policyService = policies.length > 0
    ? (services?.getPolicyService
      ? await services.getPolicyService(prisma)
      : await getVaultPolicyService(prisma))
    : null;

  for (const policy of policies) {
    // policyService is always non-null here — it's set iff policies.length > 0
    const svc = policyService!;
    const concreteName = sanitizeName(renderName(policy.name, templateCtx));
    const concreteBody = renderName(policy.body, templateCtx);
    const contentHash = sha256(concreteName + "\n" + concreteBody);

    newSnapshot.policies.hashes[concreteName] = contentHash;

    const prevHash = prevSnapshot.policies.hashes[concreteName];
    if (prevHash === contentHash) {
      // Idempotent — load existing record for AppRole resolution below
      const existing = await svc.getByName(concreteName);
      if (existing) {
        policyIdByConcreteName[concreteName] = existing.id;
        log.debug({ policy: concreteName }, "Policy unchanged — skipping write");
        await emitVaultEvent(userEventSvc, "stack_vault_policy_apply", triggeredBy, "noop", {
          stackId,
          templateVersion,
          concreteName,
          phase: "policies",
        });
        continue;
      }
    }

    log.info({ policy: concreteName }, "Upserting Vault policy");
    try {
      let existing = await svc.getByName(concreteName);
      if (!existing) {
        existing = await svc.create(
          {
            name: concreteName,
            displayName: policy.description ?? concreteName,
            description: policy.description,
            draftHclBody: concreteBody,
          },
          userId ?? "system",
        );
      } else {
        existing = await svc.update(
          existing.id,
          {
            draftHclBody: concreteBody,
            displayName: policy.description ?? existing.displayName,
          },
          userId ?? "system",
        );
      }

      const published = await svc.publish(existing.id);
      policyIdByConcreteName[concreteName] = published.id;
      anyApplied = true;

      await emitVaultEvent(userEventSvc, "stack_vault_policy_apply", triggeredBy, "completed", {
        stackId,
        templateVersion,
        concreteName,
        phase: "policies",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ policy: concreteName, err: msg }, "Policy upsert failed");
      await emitVaultEvent(userEventSvc, "stack_vault_policy_apply", triggeredBy, "failed", {
        stackId,
        templateVersion,
        concreteName,
        phase: "policies",
        error: msg,
      });
      await markStackError(prisma, stackId, `Vault policy apply failed for '${concreteName}': ${msg}`);
      return {
        status: "error",
        appliedAppRoleIdByName: {},
        error: `Vault policy apply failed for '${concreteName}': ${msg}`,
      };
    }
  }

  // =====================
  // 4. AppRoles
  // =====================
  const appRoleService = appRoles.length > 0
    ? (services?.getAppRoleService
      ? await services.getAppRoleService(prisma)
      : await getVaultAppRoleService(prisma))
    : null;

  for (const appRole of appRoles) {
    // appRoleService is always non-null here — it's set iff appRoles.length > 0
    const arSvc = appRoleService!;
    const concreteName = sanitizeName(renderName(appRole.name, templateCtx));
    const concretePolicyName = sanitizeName(renderName(appRole.policy, templateCtx));
    const contentHash = sha256(
      concreteName +
        "\n" +
        concretePolicyName +
        "\n" +
        (appRole.tokenTtl ?? "") +
        "\n" +
        (appRole.tokenMaxTtl ?? "") +
        "\n" +
        (appRole.tokenPeriod ?? "") +
        "\n" +
        String(appRole.secretIdNumUses ?? "") +
        "\n" +
        (appRole.secretIdTtl ?? ""),
    );

    newSnapshot.appRoles.hashes[concreteName] = contentHash;

    const policyId = policyIdByConcreteName[concretePolicyName];
    if (!policyId) {
      const msg = `AppRole '${concreteName}' references policy '${concretePolicyName}' which was not found after policy phase`;
      await markStackError(prisma, stackId, msg);
      return { status: "error", appliedAppRoleIdByName: {}, error: msg };
    }

    const prevHash = prevSnapshot.appRoles.hashes[concreteName];
    if (prevHash === contentHash) {
      const existing = await arSvc.getByName(concreteName);
      if (existing) {
        appliedAppRoleIdByName[appRole.name] = existing.id;
        log.debug({ appRole: concreteName }, "AppRole unchanged — skipping write");
        await emitVaultEvent(userEventSvc, "stack_vault_approle_apply", triggeredBy, "noop", {
          stackId,
          templateVersion,
          concreteName,
          phase: "appRoles",
        });
        continue;
      }
    }

    log.info({ appRole: concreteName }, "Upserting Vault AppRole");
    try {
      let existing = await arSvc.getByName(concreteName);
      if (!existing) {
        existing = await arSvc.create(
          {
            name: concreteName,
            policyId,
            secretIdNumUses: appRole.secretIdNumUses,
            secretIdTtl: appRole.secretIdTtl,
            tokenTtl: appRole.tokenTtl,
            tokenMaxTtl: appRole.tokenMaxTtl,
            tokenPeriod: appRole.tokenPeriod,
          },
          userId ?? "system",
        );
      } else {
        existing = await arSvc.update(existing.id, {
          policyId,
          secretIdNumUses: appRole.secretIdNumUses,
          secretIdTtl: appRole.secretIdTtl,
          tokenTtl: appRole.tokenTtl,
          tokenMaxTtl: appRole.tokenMaxTtl,
          tokenPeriod: appRole.tokenPeriod,
        });
      }

      const applied = await arSvc.apply(existing.id);
      appliedAppRoleIdByName[appRole.name] = applied.id;
      anyApplied = true;

      await emitVaultEvent(userEventSvc, "stack_vault_approle_apply", triggeredBy, "completed", {
        stackId,
        templateVersion,
        concreteName,
        phase: "appRoles",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ appRole: concreteName, err: msg }, "AppRole upsert failed");
      await emitVaultEvent(userEventSvc, "stack_vault_approle_apply", triggeredBy, "failed", {
        stackId,
        templateVersion,
        concreteName,
        phase: "appRoles",
        error: msg,
      });
      await markStackError(prisma, stackId, `Vault AppRole apply failed for '${concreteName}': ${msg}`);
      return {
        status: "error",
        appliedAppRoleIdByName: {},
        error: `Vault AppRole apply failed for '${concreteName}': ${msg}`,
      };
    }
  }

  // =====================
  // 5. KV
  // =====================
  const kvService = kvEntries.length > 0
    ? (services?.getKVService
      ? await services.getKVService()
      : await getVaultKVSvc())
    : null;

  for (const kv of kvEntries) {
    // kvService is always non-null here — it's set iff kvEntries.length > 0
    const kSvc = kvService!;
    // Render path via substitution
    const concretePath = renderName(kv.path, templateCtx);

    // Re-validate the concrete path — catches injection via {{inputs.x}}
    try {
      validateKvPath(concretePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ path: concretePath, err: msg }, "KV path invalid after substitution — rejecting");
      await markStackError(prisma, stackId, `KV path '${concretePath}' is invalid after substitution: ${msg}`);
      return {
        status: "error",
        appliedAppRoleIdByName: {},
        error: `KV path '${concretePath}' is invalid after substitution: ${msg}`,
      };
    }

    // Resolve fields
    const resolvedFields: Record<string, string> = {};
    for (const [fieldName, fieldSpec] of Object.entries(kv.fields)) {
      if ("fromInput" in fieldSpec) {
        const val = decryptedInputs[fieldSpec.fromInput];
        if (val === undefined) {
          const msg = `KV path '${concretePath}' field '${fieldName}' references input '${fieldSpec.fromInput}' which has no value`;
          await markStackError(prisma, stackId, msg);
          return { status: "error", appliedAppRoleIdByName: {}, error: msg };
        }
        resolvedFields[fieldName] = val;
      } else {
        resolvedFields[fieldName] = renderName(fieldSpec.value, templateCtx);
      }
    }

    const contentHash = sha256(concretePath + "\n" + JSON.stringify(resolvedFields));
    newSnapshot.kv.hashes[concretePath] = contentHash;

    const prevHash = prevSnapshot.kv.hashes[concretePath];
    if (prevHash === contentHash) {
      log.debug({ path: concretePath }, "KV entry unchanged — skipping write");
      await emitVaultEvent(userEventSvc, "stack_vault_kv_apply", triggeredBy, "noop", {
        stackId,
        templateVersion,
        concretePath,
        phase: "kv",
      });
      continue;
    }

    log.info({ path: concretePath }, "Writing KV entry");
    try {
      await kSvc.write(concretePath, resolvedFields);
      anyApplied = true;

      await emitVaultEvent(userEventSvc, "stack_vault_kv_apply", triggeredBy, "completed", {
        stackId,
        templateVersion,
        concretePath,
        phase: "kv",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ path: concretePath, err: msg }, "KV write failed");
      await emitVaultEvent(userEventSvc, "stack_vault_kv_apply", triggeredBy, "failed", {
        stackId,
        templateVersion,
        concretePath,
        phase: "kv",
        error: msg,
      });
      await markStackError(prisma, stackId, `Vault KV write failed for '${concretePath}': ${msg}`);
      return {
        status: "error",
        appliedAppRoleIdByName: {},
        error: `Vault KV write failed for '${concretePath}': ${msg}`,
      };
    }
  }

  // 6. Persist snapshot and clear any prior failure reason
  await prisma.stack.update({
    where: { id: stackId },
    data: {
      lastAppliedVaultSnapshot: newSnapshot as unknown as import("../../generated/prisma/client").Prisma.InputJsonValue,
      lastFailureReason: null,
    },
  });

  const status: VaultReconcileStatus = anyApplied ? "applied" : "noop";
  log.info({ stackId, status, appRolesMapped: Object.keys(appliedAppRoleIdByName).length }, "Vault reconcile complete");
  return { status, appliedAppRoleIdByName };
}

async function markStackError(prisma: PrismaClient, stackId: string, reason: string): Promise<void> {
  try {
    await prisma.stack.update({
      where: { id: stackId },
      data: { status: "error", lastFailureReason: reason },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), stackId },
      "Failed to mark stack as error (non-fatal)",
    );
  }
}

// =====================
// Service facades (for injection in tests)
// =====================

export interface PolicyServiceFacade {
  getByName(name: string): Promise<{ id: string; displayName: string } | null>;
  create(input: { name: string; displayName: string; description?: string; draftHclBody: string }, userId: string): Promise<{ id: string; displayName: string }>;
  update(id: string, input: { draftHclBody?: string; displayName?: string }, userId: string): Promise<{ id: string; displayName: string }>;
  publish(id: string): Promise<{ id: string }>;
}

export interface AppRoleServiceFacade {
  getByName(name: string): Promise<{ id: string } | null>;
  create(input: {
    name: string;
    policyId: string;
    secretIdNumUses?: number;
    secretIdTtl?: string;
    tokenTtl?: string;
    tokenMaxTtl?: string;
    tokenPeriod?: string;
  }, userId: string): Promise<{ id: string }>;
  update(id: string, input: {
    policyId?: string;
    secretIdNumUses?: number;
    secretIdTtl?: string;
    tokenTtl?: string;
    tokenMaxTtl?: string;
    tokenPeriod?: string;
  }): Promise<{ id: string }>;
  apply(id: string): Promise<{ id: string }>;
}

export interface KVServiceFacade {
  write(path: string, data: Record<string, unknown>): Promise<void>;
}
