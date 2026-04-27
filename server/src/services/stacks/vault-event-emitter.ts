/**
 * Unified UserEvent emitter for stack-vault apply, rollback, and delete phases.
 *
 * The reconciler and deleter previously each defined their own emitter helper
 * with subtly different status semantics and description strings. This module
 * is the single home for the cross-phase contract.
 *
 * Event-name and metadata shape is preserved from the prior helpers so existing
 * UserEvent rows + audit consumers continue to work unchanged.
 */

import { getLogger } from "../../lib/logger-factory";
import type { UserEventService } from "../user-events/user-event-service";

const log = getLogger("stacks", "vault-event-emitter");

export type VaultPhaseEventType =
  | "stack_vault_policy_apply"
  | "stack_vault_approle_apply"
  | "stack_vault_kv_apply"
  | "stack_vault_policy_rollback"
  | "stack_vault_approle_rollback"
  | "stack_vault_kv_rollback"
  | "stack_vault_policy_delete"
  | "stack_vault_approle_delete"
  | "stack_vault_kv_delete";

/**
 * Status semantics:
 *   - completed → the operation succeeded (resource applied, rolled back, or deleted)
 *   - noop      → idempotent skip (apply phase: content hash matched prior state)
 *   - skipped   → policy skip (delete phase: resource shared with another stack)
 *   - failed    → operation threw
 *
 * "noop" is normalised to UserEvent status "skipped" but with the apply-style
 * description ("Skipped (no change)") to distinguish from delete-style sharing
 * skips ("Skipped (shared)").
 */
export type VaultPhaseEventStatus = "completed" | "noop" | "skipped" | "failed";

/**
 * Emit a UserEvent row for an individual Vault phase mutation. Non-fatal on
 * failure — audit-log issues never break the calling pipeline.
 */
export async function emitVaultPhaseEvent(
  svc: UserEventService,
  eventType: VaultPhaseEventType,
  triggeredBy: string,
  status: VaultPhaseEventStatus,
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
      description: descriptionFor(eventType, status),
      metadata: { ...metadata, action: status },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), eventType },
      "Failed to emit vault audit event (non-fatal)",
    );
  }
}

function descriptionFor(eventType: VaultPhaseEventType, status: VaultPhaseEventStatus): string {
  if (status === "failed") return `Failed — ${eventType}`;
  const isDelete = eventType.endsWith("_delete");
  if (status === "noop") return `Skipped (no change) — ${eventType}`;
  if (status === "skipped") {
    return `${isDelete ? "Skipped (shared)" : "Skipped (no change)"} — ${eventType}`;
  }
  // completed
  return `${isDelete ? "Deleted" : "Applied"} — ${eventType}`;
}
