// Egress Firewall Types

/**
 * Regex for valid egress pattern strings: either a plain FQDN
 * (e.g. "api.example.com") or a wildcard suffix (e.g. "*.example.com").
 *
 * Centralised here so `server/src/routes/egress.ts` and
 * `server/src/services/stacks/schemas.ts` can both import it instead of
 * duplicating the expression.
 *
 * The two files that independently validate patterns:
 *   - server/src/routes/egress.ts         — uses FQDN_RE + WILDCARD_RE (inline copies)
 *   - server/src/services/stacks/schemas.ts — imports EGRESS_PATTERN_RE from here
 *
 * The egress route keeps its own inline copies because it imported these
 * patterns before this constant existed; they are intentionally tied together
 * by this comment so a future grep finds both.
 */
export const EGRESS_FQDN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
export const EGRESS_WILDCARD_RE = /^\*\.([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** Combined test: accepts any valid FQDN or wildcard egress pattern. */
export function isValidEgressPattern(pattern: string): boolean {
  return EGRESS_FQDN_RE.test(pattern) || EGRESS_WILDCARD_RE.test(pattern);
}

export type EgressMode = 'detect' | 'enforce';
export type EgressDefaultAction = 'allow' | 'block';
export type EgressRuleAction = 'allow' | 'block';
export type EgressRuleSource = 'user' | 'observed' | 'template';
export type EgressEventAction = 'allowed' | 'blocked' | 'observed';
/**
 * Protocol values for EgressEvent rows.
 *
 * v1 TS sidecar (legacy):
 *   - `'dns'`   — DNS query events
 *   - `'sni'`   — TLS SNI-based events (observed hostname from ClientHello)
 *   - `'http'`  — HTTP forward-proxy events (v1 sidecar meaning)
 *
 * v3 Smokescreen gateway:
 *   - `'connect'` — HTTPS CONNECT tunnel (CONNECT method)
 *   - `'http'`    — HTTP forward proxy (non-CONNECT)
 *
 * v3 fw-agent (firewall drop events):
 *   - `'tcp'`   — TCP packet dropped by the host firewall
 *   - `'udp'`   — UDP packet dropped by the host firewall
 *   - `'icmp'`  — ICMP packet dropped by the host firewall
 *
 * Note: `'http'` is overloaded — v1 sidecar used it for SNI-style detection;
 * v3 gateway uses it for explicit HTTP forward proxy. Context disambiguates.
 */
export type EgressEventProtocol = 'dns' | 'sni' | 'http' | 'connect' | 'tcp' | 'udp' | 'icmp';
export type EgressArchivedReason = 'stack-deleted' | 'environment-deleted';

/**
 * Reason strings for egress denial or firewall drop events.
 * The union is intentionally open (| string) to avoid tight coordination
 * with every reason string emitted by the gateway and fw-agent.
 */
export type EgressEventReason =
  | 'rule-deny'
  | 'ip-literal'
  | 'doh-denied'
  | 'dial-failed'
  | 'non-allowed-egress'
  | string;

export interface EgressPolicySummary {
  id: string;
  stackId: string | null;
  stackNameSnapshot: string;
  environmentId: string | null;
  environmentNameSnapshot: string;
  mode: EgressMode;
  defaultAction: EgressDefaultAction;
  version: number;
  appliedVersion: number | null;
  archivedAt: string | null;
  archivedReason: EgressArchivedReason | null;
}

export interface EgressRuleSummary {
  id: string;
  policyId: string;
  pattern: string;
  action: EgressRuleAction;
  source: EgressRuleSource;
  targets: string[];
  hits: number;
  lastHitAt: string | null;
}

// ====================
// Socket.IO Event Payloads (channel: "egress")
// ====================

/**
 * Broadcast when a single DNS query has been ingested into EgressEvent.
 * The ingester batches DB writes; this fires per-row after a batch commits.
 * Fields beyond the EgressEvent row are denormalized snapshots for the UI.
 */
export interface EgressEventBroadcast {
  id: string;
  policyId: string;
  occurredAt: string;
  sourceContainerId: string | null;
  sourceStackId: string | null;
  sourceServiceName: string | null;
  destination: string;
  matchedPattern: string | null;
  action: EgressEventAction;
  protocol: EgressEventProtocol;
  mergedHits: number;
  stackNameSnapshot: string;
  environmentNameSnapshot: string;
  environmentId: string | null;
  // v3 egress gateway fields — null for dns.query events
  target: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  bytesUp: number | null;    // BigInt from DB converted to number for JSON serialisation
  bytesDown: number | null;  // BigInt from DB converted to number for JSON serialisation
  destIp: string | null;
  destPort: number | null;
  reason: string | null;
}

/** Fired when an EgressPolicy mode/defaultAction/version/archivedAt changes. */
export interface EgressPolicyUpdatedEvent {
  policyId: string;
  environmentId: string | null;
  stackId: string | null;
  version: number;
  appliedVersion: number | null;
  mode: EgressMode;
  defaultAction: EgressDefaultAction;
  archivedAt: string | null;
}

/** Fired on rule create/update/delete. `rule` is null when changeType === 'deleted'. */
export interface EgressRuleMutationEvent {
  policyId: string;
  ruleId: string;
  changeType: 'created' | 'updated' | 'deleted';
  rule: EgressRuleSummary | null;
}

/**
 * Per-environment gateway health snapshot. Emitted by the rule pusher and
 * container-map pusher after each push attempt (success or failure), so
 * the UI can show live drift between desired (DB) and applied (gateway) state.
 */
export interface EgressGatewayHealthEvent {
  environmentId: string;
  gatewayIp: string | null;
  ok: boolean;
  rulesVersion: number;
  appliedRulesVersion: number | null;
  containerMapVersion: number;
  appliedContainerMapVersion: number | null;
  upstream: {
    servers: string[];
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };
  errorMessage?: string;
}
