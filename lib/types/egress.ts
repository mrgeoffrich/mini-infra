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
export type EgressArchivedReason =
  | 'stack-deleted'
  | 'environment-deleted'
  | 'system-infrastructure-stack';

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
  /**
   * Out-of-band NATS connection state scraped from the gateway's local
   * `/healthz` (Phase 3, §4.2). Optional/`null` when the scrape wasn't reached.
   * `"auth-failed"` lets the gateway health badge show a distinct "NATS auth
   * failing" state — the reason a rules/container-map push is timing out (the
   * gateway can't subscribe because its creds are rejected) rather than a
   * silent generic error.
   */
  natsConnState?: EgressAgentConnState | null;
}

// ----------------------------------------------------------------------------
// Out-of-band egress agent health (Phase 3, §4.2)
// ----------------------------------------------------------------------------

/**
 * The NATS connection state an egress agent reports over its local HTTP
 * `/healthz`, independent of the in-band KV heartbeat. Mirror of the Go
 * `natsbus.ConnState` values — the single source of truth for both agents and
 * the server-side scraper. `auth-failed` is the signal the 15-hour production
 * incident lacked: an agent running but with its baked-in creds rejected.
 */
export type EgressAgentConnState =
  | "connected"
  | "reconnecting"
  | "auth-failed"
  | "disconnected";

/**
 * The JSON body an egress agent returns from `GET /healthz`. Mirror of the Go
 * `natsbus.HealthReport` produced by both egress binaries and consumed by
 * `server/src/services/egress/agent-health-scraper.ts`.
 */
export interface EgressAgentHealthReport {
  /** The §4.2 connection state. */
  status: EgressAgentConnState;
  /**
   * Age (ms) of the most recent successful in-band KV heartbeat, or -1 when the
   * agent has not yet landed a heartbeat this process.
   */
  lastHeartbeatAgeMs: number;
}

// ----------------------------------------------------------------------------
// Egress firewall agent (host-singleton sidecar managed by mini-infra-server)
// ----------------------------------------------------------------------------

/** Snapshot of the fw-agent container + its admin socket health. */
export interface EgressFwAgentStatus {
  /** Whether mini-infra-server can reach the agent's admin socket. */
  available: boolean;
  /** Whether a labelled fw-agent container is currently running. */
  containerRunning: boolean;
  /** Short ID (12 chars) of the running fw-agent container, if any. */
  containerId: string | null;
  /** Reason the agent is unavailable (e.g. server not in Docker, image unset). */
  reason?: string;
  /** Health response from the agent's admin socket, if reachable. */
  health: {
    status: "ok";
  } | null;
  /**
   * Out-of-band NATS connection state scraped from the agent's local `/healthz`
   * (Phase 3, §4.2). `null` when the agent isn't running or the scrape didn't
   * reach it — distinct from `disconnected` (reached, but link is down).
   */
  natsConnState?: EgressAgentConnState | null;
  /**
   * True when the agent's container is running but its NATS connection is being
   * rejected on auth — i.e. `natsConnState === "auth-failed"`. Lets the UI show
   * a distinct "NATS auth failing" state instead of a generic "unavailable"
   * that's indistinguishable from "still starting".
   */
  authFailing?: boolean;
}

export interface EgressFwAgentConfig {
  /** Container image reference (settings override → baked-in env var). */
  image: string | null;
  /** Whether the agent is started automatically at server boot. */
  autoStart: boolean;
  /**
   * Whether the self-heal supervisor (Phase 4) may auto-recreate an egress
   * NATS-client stack that is stuck `auth-failing` (re-minting its creds).
   * Defaults ON — auto-heal is the goal — and is disabled by setting the
   * `egress-fw-agent.auto_remediation` SystemSettings value to `"false"`.
   */
  autoRemediation: boolean;
  /**
   * Whether live cred refresh (Phase 6) pushes a re-minted `.creds` file into
   * each running egress agent's volume on a NATS identity rotation, so the agent
   * recovers on its next reconnect with no container recreate. Defaults ON — and
   * is disabled by setting the `egress-fw-agent.live_cred_refresh` SystemSettings
   * value to `"false"`, in which case recovery falls back to Phase 4's
   * recreate-based self-heal.
   */
  liveCredRefresh: boolean;
}

