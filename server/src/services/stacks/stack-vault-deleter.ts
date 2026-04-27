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
import { resolveVaultServiceFacades, type VaultServiceLoaders } from "./vault-services-loader";

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

type VaultDeleteEventType =
  | "stack_vault_policy_delete"
  | "stack_vault_approle_delete"
  | "stack_vault_kv_delete";

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
 * Emit a UserEvent row for an individual Vault deletion. Non-fatal on failure.
 */
async function emitDeleteEvent(
  svc: UserEventService,
  eventType: VaultDeleteEventType,
  triggeredBy: string,
  status: "completed" | "failed" | "skipped",
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await svc.createEvent({
      eventType,
      eventCategory: "security",
      eventName: `${eventType}: ${String(metadata.concreteName ?? "")}`,
      triggeredBy,
      status,
      progress: status === "failed" ? 0 : 100,
      resourceType: "stack",
      description:
        status === "failed"
          ? `Failed — ${eventType}`
          : status === "skipped"
            ? `Skipped (shared) — ${eventType}`
            : `Deleted — ${eventType}`,
      metadata: { ...metadata, action: status },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), eventType },
      "Failed to emit vault delete audit event (non-fatal)",
    );
  }
}

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

  // ── 1. KV ──
  for (const path of kvPaths) {
    const item: VaultDeleteItem = { type: "kv", concreteName: path };
    const otherOwners = await countOtherOwners(prisma, stackId, "kv", path);

    if (otherOwners > 0) {
      log.info({ path, otherOwners }, "KV path shared with other stacks — skipping delete");
      result.skippedAsShared.push(item);
      await emitDeleteEvent(userEventSvc, "stack_vault_kv_delete", triggeredBy, "skipped", {
        stackId,
        concreteName: path,
        phase: "kv",
        otherOwners,
      });
      continue;
    }

    try {
      await kvSvc!.delete(path);
      result.deleted.push(item);
      log.info({ path }, "KV path soft-deleted");
      await emitDeleteEvent(userEventSvc, "stack_vault_kv_delete", triggeredBy, "completed", {
        stackId,
        concreteName: path,
        phase: "kv",
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        result.deleted.push(item);
        log.info({ path }, "KV path already absent — treating as deleted");
        await emitDeleteEvent(userEventSvc, "stack_vault_kv_delete", triggeredBy, "completed", {
          stackId,
          concreteName: path,
          phase: "kv",
          alreadyAbsent: true,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ path, err: msg }, "KV soft-delete failed (non-fatal — stack row will still be removed)");
        result.failed.push(item);
        await emitDeleteEvent(userEventSvc, "stack_vault_kv_delete", triggeredBy, "failed", {
          stackId,
          concreteName: path,
          phase: "kv",
          error: msg,
        });
      }
    }
  }

  // ── 2. AppRoles ──
  for (const name of appRoleNames) {
    const item: VaultDeleteItem = { type: "approle", concreteName: name };
    const otherOwners = await countOtherOwners(prisma, stackId, "approle", name);

    if (otherOwners > 0) {
      log.info({ appRole: name, otherOwners }, "AppRole shared with other stacks — skipping delete");
      result.skippedAsShared.push(item);
      await emitDeleteEvent(userEventSvc, "stack_vault_approle_delete", triggeredBy, "skipped", {
        stackId,
        concreteName: name,
        phase: "appRoles",
        otherOwners,
      });
      continue;
    }

    const existing = await appRoleSvc!.getByName(name);
    if (!existing) {
      result.deleted.push(item);
      log.info({ appRole: name }, "AppRole not found in DB — treating as deleted");
      await emitDeleteEvent(userEventSvc, "stack_vault_approle_delete", triggeredBy, "completed", {
        stackId,
        concreteName: name,
        phase: "appRoles",
        alreadyAbsent: true,
      });
      continue;
    }

    try {
      await appRoleSvc!.delete(existing.id);
      result.deleted.push(item);
      log.info({ appRole: name }, "AppRole deleted");
      await emitDeleteEvent(userEventSvc, "stack_vault_approle_delete", triggeredBy, "completed", {
        stackId,
        concreteName: name,
        phase: "appRoles",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ appRole: name, err: msg }, "AppRole delete failed (non-fatal)");
      result.failed.push(item);
      await emitDeleteEvent(userEventSvc, "stack_vault_approle_delete", triggeredBy, "failed", {
        stackId,
        concreteName: name,
        phase: "appRoles",
        error: msg,
      });
    }
  }

  // ── 3. Policies ──
  for (const name of policyNames) {
    const item: VaultDeleteItem = { type: "policy", concreteName: name };
    const otherOwners = await countOtherOwners(prisma, stackId, "policy", name);

    if (otherOwners > 0) {
      log.info({ policy: name, otherOwners }, "Policy shared with other stacks — skipping delete");
      result.skippedAsShared.push(item);
      await emitDeleteEvent(userEventSvc, "stack_vault_policy_delete", triggeredBy, "skipped", {
        stackId,
        concreteName: name,
        phase: "policies",
        otherOwners,
      });
      continue;
    }

    const existing = await policySvc!.getByName(name);
    if (!existing) {
      result.deleted.push(item);
      log.info({ policy: name }, "Policy not found in DB — treating as deleted");
      await emitDeleteEvent(userEventSvc, "stack_vault_policy_delete", triggeredBy, "completed", {
        stackId,
        concreteName: name,
        phase: "policies",
        alreadyAbsent: true,
      });
      continue;
    }

    try {
      await policySvc!.delete(existing.id);
      result.deleted.push(item);
      log.info({ policy: name }, "Policy deleted");
      await emitDeleteEvent(userEventSvc, "stack_vault_policy_delete", triggeredBy, "completed", {
        stackId,
        concreteName: name,
        phase: "policies",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ policy: name, err: msg }, "Policy delete failed (non-fatal)");
      result.failed.push(item);
      await emitDeleteEvent(userEventSvc, "stack_vault_policy_delete", triggeredBy, "failed", {
        stackId,
        concreteName: name,
        phase: "policies",
        error: msg,
      });
    }
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
