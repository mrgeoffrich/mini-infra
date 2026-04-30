/**
 * Pure helper for building `Stack.lastFailureReason` from per-service apply
 * results. Lives in its own module so it can be unit-tested without dragging
 * in Prisma / Docker (which the reconciler module pulls at import time).
 *
 * Customer feedback #5: Stack.lastFailureReason used to stay null when
 * service apply failed (port conflict, image pull error, healthcheck
 * timeout, container crash on startup). Operators had to use `docker ps` +
 * `docker logs` to find the real reason. The reconciler now calls this on
 * every failed apply.
 */

import type { ServiceApplyResult } from '@mini-infra/types';

/**
 * Hard cap on `Stack.lastFailureReason` length. Generous enough to fit the
 * service name + exit code + a couple of log lines per failed service in
 * a typical 1-3 service stack; small enough to keep the API response and
 * Socket.IO emissions snappy. Full per-service detail (with full tail logs)
 * remains available in the deployment row's `serviceResults` JSON.
 */
export const STACK_LAST_FAILURE_REASON_BUDGET = 4000;

/**
 * Build a single-line-ish summary suitable for `Stack.lastFailureReason`
 * from the per-service apply results.
 */
export function summariseServiceFailures(results: ServiceApplyResult[]): string {
  const failed = results.filter((r) => !r.success);
  if (failed.length === 0) {
    // Defensive: callers gate on allSucceeded === false, but if the array
    // is empty for some reason we want a non-null marker rather than ''.
    return 'Apply failed (no per-service detail captured).';
  }

  const parts = failed.map((r) => {
    const err = (r.error ?? 'unknown error').replace(/\s+/g, ' ').trim();
    return `${r.serviceName}: ${err}`;
  });

  const joined = parts.join(' | ');
  if (joined.length <= STACK_LAST_FAILURE_REASON_BUDGET) return joined;

  // Truncate with a marker so it's obvious in the UI that detail was cut.
  return joined.slice(0, STACK_LAST_FAILURE_REASON_BUDGET - 1) + '…';
}
