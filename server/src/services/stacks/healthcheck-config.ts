/**
 * The one seam between a stack's declared healthcheck and Docker's HealthConfig.
 *
 * `StackContainerConfig.healthcheck` stores `interval`, `timeout` and
 * `startPeriod` in **milliseconds** (declared on the shared type in
 * `lib/types/stacks.ts`). Docker's API wants nanoseconds. Every container-create
 * path must go through `healthcheckToDocker()` so the conversion exists once.
 *
 * History: this used to be inlined in three places (stack-container-manager,
 * pool-spawner, pool-addon-sidecar), each multiplying by 1e9 as though the
 * stored value were seconds — while the authoring UI and the deploy-wait path
 * both treated it as milliseconds. A UI-created app with a 30s interval stored
 * `30000` and got a Docker interval of 30,000 seconds (~8.3 hours), so the
 * healthcheck never ran. Keep the conversion here and the units can't drift
 * again.
 */
import type { StackContainerConfig } from "@mini-infra/types";

const MS_TO_NS = 1_000_000;

/** Docker's HealthConfig, in the PascalCase shape the Engine API expects. */
export interface DockerHealthConfig {
  Test: string[];
  Interval: number;
  Timeout: number;
  Retries: number;
  StartPeriod: number;
}

/**
 * Convert a stack service's declared healthcheck (ms) into Docker's
 * HealthConfig (ns). Returns `undefined` when no healthcheck is declared, so
 * callers can spread it straight into a container-create body.
 *
 * By this point template references like `{{params.x}}` have been resolved to
 * numbers by the template engine, so `Number()` is a narrowing cast rather than
 * a parse. `retries` is a count, not a duration — it is passed through as-is.
 */
export function healthcheckToDocker(
  healthcheck: StackContainerConfig["healthcheck"],
): DockerHealthConfig | undefined {
  if (!healthcheck) return undefined;

  return {
    Test: healthcheck.test,
    Interval: Number(healthcheck.interval) * MS_TO_NS,
    Timeout: Number(healthcheck.timeout) * MS_TO_NS,
    Retries: Number(healthcheck.retries),
    StartPeriod: Number(healthcheck.startPeriod) * MS_TO_NS,
  };
}

/* -------------------------------------------------------------------------- */
/* Legacy seconds → ms normalisation                                           */
/* -------------------------------------------------------------------------- */

/**
 * Durations only. `retries` is a count and must never be scaled.
 */
const DURATION_KEYS = ["interval", "timeout", "startPeriod"] as const;

/**
 * Values at or above this are assumed to be milliseconds already; anything
 * below it is assumed to be a legacy seconds value and scaled by 1000.
 *
 * Stored healthchecks are not self-describing — a `30` could be a built-in
 * template's 30 seconds or a drawer user's 30 milliseconds — so the backfill
 * discriminates on magnitude. The two populations are far apart in practice
 * (seconds: intervals 5–60, timeouts 3–10; milliseconds: intervals
 * 10000–60000, timeouts 3000–10000), and a sub-second millisecond healthcheck
 * is pathological, so the ambiguous band is empty for any realistic config.
 *
 * The threshold also makes the backfill idempotent: once a value has been
 * scaled it lands above the threshold and is never scaled twice. That matters
 * because it runs on every boot.
 */
export const MS_HEURISTIC_THRESHOLD = 1000;

export interface HealthcheckConversion {
  key: (typeof DURATION_KEYS)[number];
  from: number;
  to: number;
}

/**
 * Scale any legacy seconds durations on a healthcheck up to milliseconds.
 *
 * Pure and non-mutating: returns a new healthcheck plus the list of what it
 * changed (for logging), or `null` when nothing needed changing. Non-numeric
 * values are left alone — an unrendered template expression like
 * `"{{params.interval}}"` has no unit to convert, and its author is expected to
 * supply milliseconds.
 */
export function normaliseHealthcheckToMs(
  healthcheck: Record<string, unknown>,
): { healthcheck: Record<string, unknown>; conversions: HealthcheckConversion[] } | null {
  const conversions: HealthcheckConversion[] = [];
  const next = { ...healthcheck };

  for (const key of DURATION_KEYS) {
    const value = next[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value <= 0 || value >= MS_HEURISTIC_THRESHOLD) continue;

    const scaled = Math.round(value * 1000);
    next[key] = scaled;
    conversions.push({ key, from: value, to: scaled });
  }

  return conversions.length > 0 ? { healthcheck: next, conversions } : null;
}
