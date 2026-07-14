import { computeStackAttention, type StackAttention, type StackInfo } from "@mini-infra/types";

export type { StackAttention };

/**
 * Read a stack's "needs attention" rollup.
 *
 * The server computes this inside `serializeStack()` and ships it on the API, so
 * every consumer — this UI, the agent sidecar, an API-key integration — gets the
 * same answer instead of each reimplementing the logic. This used to be a local
 * reimplementation that only the browser had.
 *
 * The local fallback covers stacks that came from an endpoint predating the
 * rollup; it calls the *same* shared function the server does (from
 * `@mini-infra/types`), so the two can't drift. It will under-report NATS drift
 * when the payload lacks `natsDrift`, which is exactly what the server does for
 * the same payload.
 */
export function getStackAttention(stack: StackInfo): StackAttention {
  return stack.needsAttention ?? computeStackAttention(stack);
}
