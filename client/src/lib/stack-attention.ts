import type { StackInfo } from "@mini-infra/types";

export interface StackAttention {
  /** True when the stack has one or more unresolved conditions. */
  needsAttention: boolean;
  /** Human-readable reasons, each phrased as "what's wrong → what to do". */
  reasons: string[];
  /** True when a newer template version is available (a softer signal). */
  updateAvailable: boolean;
}

/**
 * Roll every "needs attention" signal for a stack into one shape:
 *   - `error` status (last apply failed)
 *   - `drifted`/`pending` status (definition vs. live divergence / unapplied edits)
 *   - NATS configuration drift (returned on stack GET; orthogonal to status)
 *   - a newer template version being available (an upgrade opportunity)
 *
 * Used by the /stacks list and the stack detail page so one indicator can
 * summarise all of the above instead of scattering separate badges.
 */
export function getStackAttention(stack: StackInfo): StackAttention {
  const reasons: string[] = [];

  if (stack.status === "error") {
    reasons.push(
      stack.lastFailureReason
        ? `Last apply failed: ${stack.lastFailureReason}`
        : "The last apply failed — retry Apply.",
    );
  } else if (stack.status === "drifted") {
    reasons.push("Live containers have drifted from the definition — run Apply to reconcile.");
  } else if (stack.status === "pending") {
    reasons.push("The definition changed but hasn't been applied — run Apply.");
  }

  if (stack.natsDrift?.drifted) {
    reasons.push("NATS configuration has drifted from the last applied snapshot.");
  }

  const updateAvailable = stack.templateUpdateAvailable === true;
  if (updateAvailable) {
    reasons.push("A newer template version is available — Upgrade & deploy to adopt it.");
  }

  return {
    needsAttention: reasons.length > 0,
    reasons,
    updateAvailable,
  };
}
