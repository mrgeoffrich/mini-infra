// ====================
// Shared HTTP Client Primitives
// ====================
//
// Header-name constants and the correlation-ID generator used by the
// client's typed `apiFetch` (see client/src/lib/api-client.ts). Kept here
// (rather than in the client) so any future consumer (e.g. the agent
// sidecar) can share the exact same header names and ID format without
// re-deriving them.
//
// This module has zero runtime dependencies, matching the rest of
// `@mini-infra/types`.

/** Canonical HTTP header names used by client fetch calls and read by server middleware/logging. */
export const HttpHeader = {
  ContentType: "Content-Type",
  CorrelationId: "X-Correlation-ID",
} as const satisfies Record<string, string>;

export type HttpHeaderName = (typeof HttpHeader)[keyof typeof HttpHeader];

/**
 * Generate a correlation ID for request tracing.
 *
 * Format matches the historical per-hook `generateCorrelationId()` copies
 * (e.g. `containers-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`):
 * a caller-supplied prefix, the current epoch-millis timestamp, and a
 * 7-character base36 random suffix, joined with `-`. Server-side log
 * correlation only treats this as an opaque tracing token, but the shape is
 * kept identical so existing dashboards/log queries built around the old
 * format keep working.
 */
export function newCorrelationId(prefix = "req"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
