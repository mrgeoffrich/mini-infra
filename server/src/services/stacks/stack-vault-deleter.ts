/**
 * Vault cascade phase for stack deletion.
 *
 * Reads the stack's last applied snapshot, derives the concrete inventory of
 * Vault objects owned by the stack, and removes each one that is not shared
 * with another stack. Deletion order: KV → AppRoles → Policies (reverse apply
 * order so AppRoles are unbound before their policy is removed).
 *
 * Sharing rules:
 *   - A resource is shared when another stack's StackVaultResource row carries
 *     the same (type, concreteName) pair.
 *   - Per-instance resources (unique concreteName, scope "stack") are always
 *     safe to delete.
 *
 * Failure handling:
 *   - Vault 404 → treated as success (idempotent).
 *   - Other errors → logged + added to `failed[]`; remaining resources are
 *     still attempted. The stack row is removed regardless.
 */

import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { decryptSnapshot } from "./stack-vault-snapshot";
import { UserEventService } from "../user-events/user-event-service";
import {
  resolveVaultServiceFacades,
  type VaultServiceLoaders,
} from "./vault-services-loader";
import { emitVaultPhaseEvent, type VaultPhaseEventType } from "./vault-event-emitter";

const log = getLogger("stacks", "stack-vault-deleter");

// =====================
// Public types
// =====================

export interface VaultDeleteItem {
  type: "policy" | "approle" | "kv";
  concreteName: string;
}

export interface StackVaultDeleteResult {
  deleted: VaultDeleteItem[];
  skippedAsShared: VaultDeleteItem[];
  failed: VaultDeleteItem[];
}

// =====================
// Service facade re-exports — kept under the legacy `*DeleteFacade` names
// so existing imports keep resolving; canonical types live in
// `vault-services-loader.ts`.
// =====================

export type {
  VaultPolicyFacade as PolicyDeleteFacade,
  VaultAppRoleFacade as AppRoleDeleteFacade,
  VaultKVFacade as KVDeleteFacade,
} from "./vault-services-loader";

/** Alias retained for callers that still pass `VaultDeleterServices`. */
export type VaultDeleterServices = VaultServiceLoaders;

// =====================
// Helpers
// =====================

/**
 * Check if a Vault error from a delete operation is a 404 (resource already
 * gone). Different vault services surface this differently — check for
 * "not found" / "404" strings and the `status` property on VaultKVError /
 * VaultHttpError shapes.
 */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("404")) return true;
    const withStatus = err as Error & { status?: number; code?: string };
    if (withStatus.status === 404) return true;
    if (withStatus.code === "not_found") return true;
  }
  return false;
}

/**
 * Count how many OTHER stacks (not `excludeStackId`) own a resource with the
 * given type and concreteName.
 */
async function countOtherOwners(
  prisma: PrismaClient,
  excludeStackId: string,
  type: string,
  concreteName: string,
): Promise<number> {
  return prisma.stackVaultResource.count({
    where: {
      stackId: { not: excludeStackId },
      type,
      concreteName,
    },
  });
}

// =====================
// Per-resource delete pipeline
// =====================

interface DeletePhaseCtx {
  prisma: PrismaClient;
  stackId: string;
  triggeredBy: string;
  userEventSvc: UserEventService;
  result: StackVaultDeleteResult;
}

interface DeleteResourceArgs {
  type: VaultDeleteItem["type"];
  concreteName: string;
  /** Metadata `phase` value — preserved verbatim from the prior per-loop emits. */
  phase: "kv" | "appRoles" | "policies";
  eventType: VaultPhaseEventType;
  /** Log-line key used to identify this resource ("path", "appRole", "policy"). */
  logKey: "path" | "appRole" | "policy";
  /**
   * Optional pre-flight lookup. Returning null short-circuits the delete and
   * marks the item as already-absent. KV deletes by path and skips this step.
   */
  preflightLookup?: () => Promise<{ id: string } | null>;
  /**
   * Perform the actual delete. Receives the id resolved by `preflightLookup`,
   * or undefined when no preflight ran.
   */
  attemptDelete: (preflightId: string | undefined) => Promise<void>;
}

async function processDeleteResource(
  ctx: DeletePhaseCtx,
  args: DeleteResourceArgs,
): Promise<void> {
  const { prisma, stackId, triggeredBy, userEventSvc, result } = ctx;
  const { type, concreteName, phase, eventType, logKey, preflightLookup, attemptDelete } = args;
  const item: VaultDeleteItem = { type, concreteName };

  const otherOwners = await countOtherOwners(prisma, stackId, type, concreteName);
  if (otherOwners > 0) {
    log.info(
      { [logKey]: concreteName, otherOwners },
      `${type} shared with other stacks — skipping delete`,
    );
    result.skippedAsShared.push(item);
    await emitVaultPhaseEvent(userEventSvc, eventType, triggeredBy, "skipped", {
      stackId,
      concreteName,
      phase,
      otherOwners,
    });
    return;
  }

  let preflightId: string | undefined;
  if (preflightLookup) {
    const existing = await preflightLookup();
    if (!existing) {
      result.deleted.push(item);
      log.info({ [logKey]: concreteName }, `${type} not found in DB — treating as deleted`);
      await emitVaultPhaseEvent(userEventSvc, eventType, triggeredBy, "completed", {
        stackId,
        concreteName,
        phase,
        alreadyAbsent: true,
      });
      return;
    }
    preflightId = existing.id;
  }

  try {
    await attemptDelete(preflightId);
    result.deleted.push(item);
    log.info({ [logKey]: concreteName }, `${type} deleted`);
    await emitVaultPhaseEvent(userEventSvc, eventType, triggeredBy, "completed", {
      stackId,
      concreteName,
      phase,
    });
  } catch (err) {
    if (isNotFoundError(err)) {
      result.deleted.push(item);
      log.info({ [logKey]: concreteName }, `${type} already absent — treating as deleted`);
      await emitVaultPhaseEvent(userEventSvc, eventType, triggeredBy, "completed", {
        stackId,
        concreteName,
        phase,
        alreadyAbsent: true,
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ [logKey]: concreteName, err: msg }, `${type} delete failed (non-fatal)`);
      result.failed.push(item);
      await emitVaultPhaseEvent(userEventSvc, eventType, triggeredBy, "failed", {
        stackId,
        concreteName,
        phase,
        error: msg,
      });
    }
  }
}

// =====================
// Public entry point
// =====================

/**
 * Run the Vault cascade for a stack that is about to be deleted.
 *
 * This must be called BEFORE the stack row is removed from the DB so that the
 * sharing-check query can distinguish this stack from others.
 *
 * Deletion order: KV → AppRoles → Policies.
 *
 * On a 404 from Vault, the resource is treated as already deleted (success).
 * On any other error, the item is added to `failed[]` and processing continues.
 *
 * If no snapshot exists (never applied, or pre-PR4 schema), the function
 * returns immediately with empty result sets.
 */
export async function runStackVaultDeleter(
  prisma: PrismaClient,
  stackId: string,
  triggeredBy: string,
  services?: VaultDeleterServices,
): Promise<StackVaultDeleteResult> {
  const result: StackVaultDeleteResult = { deleted: [], skippedAsShared: [], failed: [] };

  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    select: { lastAppliedVaultSnapshot: true },
  });

  if (!stack || !stack.lastAppliedVaultSnapshot) {
    log.debug({ stackId }, "No vault snapshot — skipping Vault cascade");
    return result;
  }

  const snapshot = decryptSnapshot(stack.lastAppliedVaultSnapshot);
  if (!snapshot) {
    log.warn(
      { stackId },
      "Vault snapshot could not be decrypted (pre-PR4 or corrupt) — skipping cascade",
    );
    return result;
  }

  const userEventSvc = new UserEventService(prisma);

  const kvPaths = Object.keys(snapshot.kv);
  const appRoleNames = Object.keys(snapshot.appRoles);
  const policyNames = Object.keys(snapshot.policies);

  const { policy: policySvc, appRole: appRoleSvc, kv: kvSvc } =
    await resolveVaultServiceFacades(
      prisma,
      {
        policy: policyNames.length > 0,
        appRole: appRoleNames.length > 0,
        kv: kvPaths.length > 0,
      },
      services,
    );

  const ctx: DeletePhaseCtx = { prisma, stackId, triggeredBy, userEventSvc, result };

  // KV → AppRoles → Policies (reverse apply order: AppRoles unbound before policy is removed).
  for (const path of kvPaths) {
    await processDeleteResource(ctx, {
      type: "kv",
      concreteName: path,
      phase: "kv",
      eventType: "stack_vault_kv_delete",
      logKey: "path",
      // KV deletes by path with no pre-flight existence check; "already absent"
      // surfaces as a 404 in the catch block.
      attemptDelete: () => kvSvc!.delete(path),
    });
  }

  for (const name of appRoleNames) {
    await processDeleteResource(ctx, {
      type: "approle",
      concreteName: name,
      phase: "appRoles",
      eventType: "stack_vault_approle_delete",
      logKey: "appRole",
      preflightLookup: () => appRoleSvc!.getByName(name),
      attemptDelete: (existingId) => appRoleSvc!.delete(existingId!),
    });
  }

  for (const name of policyNames) {
    await processDeleteResource(ctx, {
      type: "policy",
      concreteName: name,
      phase: "policies",
      eventType: "stack_vault_policy_delete",
      logKey: "policy",
      preflightLookup: () => policySvc!.getByName(name),
      attemptDelete: (existingId) => policySvc!.delete(existingId!),
    });
  }

  log.info(
    {
      stackId,
      deleted: result.deleted.length,
      skipped: result.skippedAsShared.length,
      failed: result.failed.length,
    },
    "Vault cascade complete",
  );
  return result;
}
