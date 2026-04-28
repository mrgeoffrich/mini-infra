/**
 * Admin API contract types — source of truth for the HTTP API contract.
 * Both the admin router and server-side pusher must conform to these types.
 */

// ---------------------------------------------------------------------------
// POST /admin/rules
// ---------------------------------------------------------------------------

export interface EgressRule {
  id: string;
  /** Exact domain name OR wildcard like '*.suffix.example' */
  pattern: string;
  action: "allow" | "block";
  /** Service names within the stack this rule applies to; [] = all services */
  targets: string[];
}

export interface StackPolicy {
  mode: "detect" | "enforce";
  defaultAction: "allow" | "block";
  rules: EgressRule[];
}

export interface RulesSnapshotRequest {
  version: number;
  /** Optional upstream DNS override for this push (rare) */
  defaultUpstream?: string[];
  /** Map of stackId -> policy */
  stackPolicies: Record<string, StackPolicy>;
}

export interface RulesSnapshotResponse {
  version: number;
  accepted: true;
  ruleCount: number;
  stackCount: number;
}

// ---------------------------------------------------------------------------
// POST /admin/container-map
// ---------------------------------------------------------------------------

export interface ContainerMapEntry {
  ip: string;
  stackId: string;
  serviceName: string;
  containerId?: string;
}

export interface ContainerMapRequest {
  version: number;
  entries: ContainerMapEntry[];
}

export interface ContainerMapResponse {
  version: number;
  accepted: true;
  entryCount: number;
}

// ---------------------------------------------------------------------------
// GET /admin/health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  rulesVersion: number;
  containerMapVersion: number;
  uptimeSeconds: number;
  upstream: {
    servers: string[];
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };
}

// ---------------------------------------------------------------------------
// GET /admin/stats
// ---------------------------------------------------------------------------

export interface StatsResponse {
  queriesTotal: number;
  queriesByAction: {
    allowed: number;
    blocked: number;
    observed: number;
  };
  queriesByQType: Record<string, number>;
  uniqueSourcesSeen: number;
  upstreamErrors: number;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Error response
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  error: string;
  detail?: unknown;
}
