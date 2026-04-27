/**
 * Pre-service Vault reconciliation phase for stack apply.
 *
 * Runs before the existing container reconcile loop. Templates with a non-empty
 * `vault: { policies, appRoles, kv }` section have those resources upserted into
 * Vault. Each sub-phase is skipped entirely when no items are declared; skipping
 * is also applied per-item using content hashes against the last applied snapshot
 * for idempotency.
 *
 * Pipeline:
 *   1. Decrypt encryptedInputValues → verify all required non-rotateOnUpgrade have values
 *   2. Load + decrypt prior SnapshotV2 (null = no rollback target)
 *   3. Build template context (substitutes {{stack.id}}, {{environment.*}}, {{inputs.*}})
 *   4. Policies  — render name + body, hash, upsert+publish; track written
 *   5. AppRoles  — render name, resolve policy, upsert+apply; track written
 *   6. KV        — render path (re-validate), resolve fromInput, hash, write; track written
 *   7. On any phase failure → rollback written resources in reverse (KV→AR→Policy)
 *      from the prior snapshot's concrete bodies. If no prior snapshot, log + surface orphans.
 *   8. Return new SnapshotV2 (encrypted) for the caller to commit.
 *
 * Rollback notes:
 *   - KV is forward-only (append-only version history). Restore writes a new version.
 *     Audit events carry triggeredBy "stack-apply:<id>:rollback" to distinguish restores.
 *   - Rollback failures are accumulated into lastFailureReason; status = error.
 *   - Resources NOT touched this apply are NOT restored.
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
import {
  encryptSnapshot,
  decryptSnapshot,
  emptySnapshotV2,
  computeRestoreItems,
  type SnapshotV2,
  type SnapshotV2PolicyEntry,
  type SnapshotV2AppRoleEntry,
  type SnapshotV2KvEntry,
  type AppliedThisRun,
} from "./stack-vault-snapshot";
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
  /**
   * Encrypted snapshot blob to persist — caller commits this with any other writes.
   * Undefined on error or noop (no changes to persist).
   */
  encryptedSnapshot?: string;
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
 * Render a string through the template context. Keeps the raw
 * string if it has no template tokens. Used for names, paths, and HCL bodies.
 */
function renderTemplate(template: string, ctx: TemplateContext): string {
  if (!template.includes("{{")) return template;
  return resolveTemplate(template, ctx);
}

type VaultEventType =
  | "stack_vault_policy_apply"
  | "stack_vault_approle_apply"
  | "stack_vault_kv_apply"
  | "stack_vault_policy_rollback"
  | "stack_vault_approle_rollback"
  | "stack_vault_kv_rollback";

/** Emit a UserEvent row for an individual Vault mutation. Non-fatal on failure. */
async function emitVaultEvent(
  svc: UserEventService,
  eventType: VaultEventType,
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
      status: status === "noop" ? "skipped" : status,
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
// Rollback helpers
// =====================

/**
 * Attempt to restore Vault to the state described in priorSnapshot for the
 * resources that were written during this apply run.
 *
 * Restore order: KV → AppRoles → Policies (reverse apply order). This ensures
 * that when an AppRole is re-bound to its prior policy, the policy body is
 * already restored.
 *
 * Returns a string describing any rollback failures, or null if clean.
 */
async function rollbackApplied(
  appliedThisRun: AppliedThisRun,
  priorSnapshot: SnapshotV2,
  stackId: string,
  rollbackTriggeredBy: string,
  svc: UserEventService,
  services: {
    policyService: PolicyServiceFacade | null;
    appRoleService: AppRoleServiceFacade | null;
    kvService: KVServiceFacade | null;
  },
): Promise<string | null> {
  const { kvToRestore, appRolesToRestore, policiesToRestore } = computeRestoreItems({
    priorSnapshot,
    appliedThisRun,
  });

  const rollbackErrors: string[] = [];

  // ── KV restore (forward-only: writes a new version) ──
  if (kvToRestore.length > 0 && services.kvService) {
    for (const { path, entry } of kvToRestore) {
      try {
        await services.kvService.write(path, entry.fields);
        await emitVaultEvent(svc, "stack_vault_kv_rollback", rollbackTriggeredBy, "completed", {
          stackId,
          concretePath: path,
          phase: "kv",
          action: "rollback",
        });
        log.info({ path }, "KV rollback write completed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rollbackErrors.push(`KV rollback failed for '${path}': ${msg}`);
        await emitVaultEvent(svc, "stack_vault_kv_rollback", rollbackTriggeredBy, "failed", {
          stackId,
          concretePath: path,
          phase: "kv",
          action: "rollback",
          error: msg,
        });
        log.error({ path, err: msg }, "KV rollback write failed");
      }
    }
  }

  // ── AppRole restore ──
  if (appRolesToRestore.length > 0 && services.appRoleService) {
    const arSvc = services.appRoleService;
    for (const { name, entry } of appRolesToRestore) {
      try {
        // Re-lookup policy by name to get its ID — policy may have been restored already.
        // If the policy service isn't available we can still attempt the update with the
        // known policy name; VaultAppRoleService.getByName gives us the existing record.
        const existing = await arSvc.getByName(name);
        if (existing) {
          // We need the policy DB ID. Use policy service lookup if available.
          let policyId: string | undefined;
          if (services.policyService) {
            const pol = await services.policyService.getByName(entry.policy);
            policyId = pol?.id;
          }
          if (policyId) {
            await arSvc.update(existing.id, {
              policyId,
              tokenPeriod: entry.tokenPeriod ?? undefined,
              tokenTtl: entry.tokenTtl ?? undefined,
              tokenMaxTtl: entry.tokenMaxTtl ?? undefined,
              secretIdNumUses: entry.secretIdNumUses ?? undefined,
              secretIdTtl: entry.secretIdTtl ?? undefined,
            });
            await arSvc.apply(existing.id);
          } else {
            // Policy ID unavailable; apply without changing policy binding.
            await arSvc.apply(existing.id);
          }
        }
        await emitVaultEvent(svc, "stack_vault_approle_rollback", rollbackTriggeredBy, "completed", {
          stackId,
          concreteName: name,
          phase: "appRoles",
          action: "rollback",
        });
        log.info({ appRole: name }, "AppRole rollback completed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rollbackErrors.push(`AppRole rollback failed for '${name}': ${msg}`);
        await emitVaultEvent(svc, "stack_vault_approle_rollback", rollbackTriggeredBy, "failed", {
          stackId,
          concreteName: name,
          phase: "appRoles",
          action: "rollback",
          error: msg,
        });
        log.error({ appRole: name, err: msg }, "AppRole rollback failed");
      }
    }
  }

  // ── Policy restore ──
  if (policiesToRestore.length > 0 && services.policyService) {
    const polSvc = services.policyService;
    for (const { name, entry } of policiesToRestore) {
      try {
        const existing = await polSvc.getByName(name);
        if (existing) {
          await polSvc.update(existing.id, { draftHclBody: entry.body }, "system");
          await polSvc.publish(existing.id);
        } else {
          // Resource was created during this apply (didn't exist before) — no prior state to restore.
          log.warn({ policy: name }, "Policy not found during rollback — may have been created this apply");
        }
        await emitVaultEvent(svc, "stack_vault_policy_rollback", rollbackTriggeredBy, "completed", {
          stackId,
          concreteName: name,
          phase: "policies",
          action: "rollback",
        });
        log.info({ policy: name }, "Policy rollback completed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rollbackErrors.push(`Policy rollback failed for '${name}': ${msg}`);
        await emitVaultEvent(svc, "stack_vault_policy_rollback", rollbackTriggeredBy, "failed", {
          stackId,
          concreteName: name,
          phase: "policies",
          action: "rollback",
          error: msg,
        });
        log.error({ policy: name, err: msg }, "Policy rollback failed");
      }
    }
  }

  return rollbackErrors.length > 0 ? rollbackErrors.join("; ") : null;
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
  const rollbackTriggeredBy = `stack-apply:${stackId}:rollback`;

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

  // 2. Load + decrypt prior snapshot — null means no rollback target
  const priorSnapshot: SnapshotV2 | null = stackRow.lastAppliedVaultSnapshot
    ? decryptSnapshot(stackRow.lastAppliedVaultSnapshot)
    : null;

  if (stackRow.lastAppliedVaultSnapshot && priorSnapshot === null) {
    log.warn(
      { stackId },
      "Prior vault snapshot could not be decrypted (pre-PR4 schema or corrupt) — rollback unavailable if this apply fails",
    );
  }

  // 3. Build template context including inputs namespace
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

  // The new SnapshotV2 being built by this apply run
  const newSnapshot = emptySnapshotV2();

  // Track what we write during this apply for rollback targeting
  const appliedThisRun: AppliedThisRun = { policies: [], appRoles: [], kv: [] };

  const appliedAppRoleIdByName: Record<string, string> = {};
  const userEventSvc = new UserEventService(prisma);
  let anyApplied = false;

  // Lazy-load service facades
  const policyService = policies.length > 0
    ? (services?.getPolicyService
      ? await services.getPolicyService(prisma)
      : await getVaultPolicyService(prisma))
    : null;

  const appRoleService = appRoles.length > 0
    ? (services?.getAppRoleService
      ? await services.getAppRoleService(prisma)
      : await getVaultAppRoleService(prisma))
    : null;

  const kvService = kvEntries.length > 0
    ? (services?.getKVService
      ? await services.getKVService()
      : await getVaultKVSvc())
    : null;

  // Helper: handle a phase failure with rollback
  async function handlePhaseFailure(failMsg: string): Promise<StackVaultReconcileResult> {
    log.error({ stackId, failMsg }, "Vault reconcile phase failed — attempting rollback");

    const rollbackServices = { policyService, appRoleService, kvService };

    let combinedFailureReason = failMsg;

    if (priorSnapshot === null) {
      // No prior snapshot → cannot roll back; orphans may exist
      const orphanMsg = stackRow.lastAppliedVaultSnapshot
        ? "rollback unavailable: snapshot is pre-PR4 schema"
        : "first apply failed; vault may have orphan policies/approles/kv — delete the stack to clean up";
      log.error({ stackId }, `Vault rollback skipped: ${orphanMsg}`);
      combinedFailureReason = `${failMsg}; ${orphanMsg}`;
    } else {
      const rollbackError = await rollbackApplied(
        appliedThisRun,
        priorSnapshot,
        stackId,
        rollbackTriggeredBy,
        userEventSvc,
        rollbackServices,
      );
      if (rollbackError) {
        combinedFailureReason = `${failMsg}; rollback errors: ${rollbackError}`;
        log.error({ stackId, rollbackError }, "Rollback completed with errors");
      } else {
        log.info({ stackId }, "Rollback completed successfully");
      }
    }

    await markStackError(prisma, stackId, combinedFailureReason);
    return {
      status: "error",
      appliedAppRoleIdByName: {},
      error: combinedFailureReason,
    };
  }

  // =====================
  // 4. Policies
  // =====================
  /** concreteName → DB id, built as we upsert so AppRoles can reference it */
  const policyIdByConcreteName: Record<string, string> = {};

  for (const policy of policies) {
    const svc = policyService!;
    const concreteName = sanitizeName(renderTemplate(policy.name, templateCtx));
    const concreteBody = renderTemplate(policy.body, templateCtx);
    const contentHash = sha256(concreteName + "\n" + concreteBody);

    const policyEntry: SnapshotV2PolicyEntry = {
      body: concreteBody,
      scope: policy.scope,
      hash: contentHash,
    };
    newSnapshot.policies[concreteName] = policyEntry;

    const prevEntry = priorSnapshot?.policies[concreteName];
    if (prevEntry?.hash === contentHash) {
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
      appliedThisRun.policies.push(concreteName);
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
      return handlePhaseFailure(`Vault policy apply failed for '${concreteName}': ${msg}`);
    }
  }

  // =====================
  // 5. AppRoles
  // =====================
  for (const appRole of appRoles) {
    const arSvc = appRoleService!;
    const concreteName = sanitizeName(renderTemplate(appRole.name, templateCtx));
    const concretePolicyName = sanitizeName(renderTemplate(appRole.policy, templateCtx));
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

    const appRoleEntry: SnapshotV2AppRoleEntry = {
      policy: concretePolicyName,
      tokenPeriod: appRole.tokenPeriod ?? null,
      tokenTtl: appRole.tokenTtl ?? null,
      tokenMaxTtl: appRole.tokenMaxTtl ?? null,
      secretIdNumUses: appRole.secretIdNumUses ?? null,
      secretIdTtl: appRole.secretIdTtl ?? null,
      scope: appRole.scope,
      hash: contentHash,
    };
    newSnapshot.appRoles[concreteName] = appRoleEntry;

    const policyId = policyIdByConcreteName[concretePolicyName];
    if (!policyId) {
      const msg = `AppRole '${concreteName}' references policy '${concretePolicyName}' which was not found after policy phase`;
      return handlePhaseFailure(msg);
    }

    const prevEntry = priorSnapshot?.appRoles[concreteName];
    if (prevEntry?.hash === contentHash) {
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
      appliedThisRun.appRoles.push(concreteName);
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
      return handlePhaseFailure(`Vault AppRole apply failed for '${concreteName}': ${msg}`);
    }
  }

  // =====================
  // 6. KV
  // =====================
  for (const kv of kvEntries) {
    const kSvc = kvService!;
    const concretePath = renderTemplate(kv.path, templateCtx);

    try {
      validateKvPath(concretePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ path: concretePath, err: msg }, "KV path invalid after substitution — rejecting");
      return handlePhaseFailure(`KV path '${concretePath}' is invalid after substitution: ${msg}`);
    }

    // Resolve fields
    const resolvedFields: Record<string, string> = {};
    for (const [fieldName, fieldSpec] of Object.entries(kv.fields)) {
      if ("fromInput" in fieldSpec) {
        const val = decryptedInputs[fieldSpec.fromInput];
        if (val === undefined) {
          const msg = `KV path '${concretePath}' field '${fieldName}' references input '${fieldSpec.fromInput}' which has no value`;
          return handlePhaseFailure(msg);
        }
        resolvedFields[fieldName] = val;
      } else {
        resolvedFields[fieldName] = renderTemplate(fieldSpec.value, templateCtx);
      }
    }

    const contentHash = sha256(concretePath + "\n" + JSON.stringify(resolvedFields));
    const kvEntry: SnapshotV2KvEntry = { fields: resolvedFields, hash: contentHash };
    newSnapshot.kv[concretePath] = kvEntry;

    const prevEntry = priorSnapshot?.kv[concretePath];
    if (prevEntry?.hash === contentHash) {
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
      appliedThisRun.kv.push(concretePath);
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
      return handlePhaseFailure(`Vault KV write failed for '${concretePath}': ${msg}`);
    }
  }

  const status: VaultReconcileStatus = anyApplied ? "applied" : "noop";
  log.info({ stackId, status, appRolesMapped: Object.keys(appliedAppRoleIdByName).length }, "Vault reconcile complete");

  await upsertStackVaultResources(prisma, stackId, newSnapshot);

  const encryptedSnapshot = encryptSnapshot(newSnapshot);
  return { status, appliedAppRoleIdByName, encryptedSnapshot };
}

/**
 * Upsert StackVaultResource rows to reflect the concrete Vault objects owned
 * by this stack after a successful apply. Existing rows for this stack are
 * replaced wholesale so stale entries from prior template versions are pruned.
 * Non-fatal on failure.
 */
async function upsertStackVaultResources(
  prisma: PrismaClient,
  stackId: string,
  snapshot: SnapshotV2,
): Promise<void> {
  try {
    const rows: Array<{ stackId: string; type: string; concreteName: string; scope: string | null }> = [];

    for (const [name, entry] of Object.entries(snapshot.policies)) {
      rows.push({ stackId, type: "policy", concreteName: name, scope: entry.scope ?? null });
    }
    for (const [name, entry] of Object.entries(snapshot.appRoles)) {
      rows.push({ stackId, type: "approle", concreteName: name, scope: entry.scope ?? null });
    }
    for (const path of Object.keys(snapshot.kv)) {
      rows.push({ stackId, type: "kv", concreteName: path, scope: null });
    }

    await prisma.$transaction([
      prisma.stackVaultResource.deleteMany({ where: { stackId } }),
      ...rows.map((r) =>
        prisma.stackVaultResource.create({ data: r }),
      ),
    ]);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), stackId },
      "Failed to upsert StackVaultResource index (non-fatal)",
    );
  }
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
