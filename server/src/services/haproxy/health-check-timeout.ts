/**
 * Shared health-check timeout resolution for HAProxy blue-green deploys.
 *
 * The blue-green state machines wait up to this long for a freshly-deployed
 * server to report UP in HAProxy before failing the deploy and rolling back.
 * It used to be hardcoded to 90s in three state machines plus
 * `perform-health-checks.ts` — too short for heavy images that run DB
 * migrations or warm large caches before binding their port (e.g. an app that
 * imports a ~1 GB CAD kernel on boot). The value is now sourced per-service
 * from `healthcheck.startPeriod` (the app's declared boot grace) so
 * slow-booting services can extend it.
 *
 * Unit note: `healthcheck.startPeriod` is **milliseconds** — the canonical unit
 * declared on `StackContainerConfig` in `lib/types/stacks.ts` and shared by
 * every authoring surface, the built-in templates, and the DB columns.
 *
 * This used to say the ms assumption held because the application authoring UI
 * was "the surface every StatelessWeb/AdoptedWeb service is created through".
 * That premise was false — this function is also reached by template-authored
 * services, which stored seconds, so a template's `startPeriod: 30` resolved to
 * 30 ms, fell under the 90s floor below, and silently clamped to the default.
 * The slow-boot extension was inert for every template-authored service. The
 * unit is now pinned at the type, so the assumption holds by declaration.
 *
 * We never shorten below the historical 90s default and cap at 10 minutes:
 * the timeout is an *upper bound* on the wait, not a fixed delay — a healthy
 * server flips UP as soon as it responds, so flooring only affects how long a
 * genuinely-failing deploy waits before giving up (never slows a good one),
 * and the cap stops a misconfigured value from hanging a deploy indefinitely.
 */
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 90_000;
export const MAX_HEALTH_CHECK_TIMEOUT_MS = 600_000;

/**
 * Resolve the effective health-check timeout (ms) from a service's declared
 * `healthcheck.startPeriod` (ms). Falls back to the 90s default when unset or
 * invalid, floors at the default, and caps at the 10-minute maximum.
 */
export function resolveHealthCheckTimeoutMs(startPeriodMs: number | undefined | null): number {
  const requested =
    startPeriodMs != null && Number.isFinite(startPeriodMs) && startPeriodMs > 0
      ? startPeriodMs
      : DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  return Math.min(Math.max(requested, DEFAULT_HEALTH_CHECK_TIMEOUT_MS), MAX_HEALTH_CHECK_TIMEOUT_MS);
}
