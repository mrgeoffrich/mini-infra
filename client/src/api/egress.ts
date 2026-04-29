/**
 * Egress Firewall API client functions.
 *
 * All fetchers follow the same shape as the rest of the app:
 * raw `fetch` with credentials + X-Correlation-ID header, throw on non-OK.
 */

import type {
  EgressPolicySummary,
  EgressRuleSummary,
  EgressEventBroadcast,
  EgressMode,
  EgressDefaultAction,
} from "@mini-infra/types";

function generateCorrelationId(): string {
  return `egress-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Response envelope types
// ====================

// All egress list endpoints return flat envelopes matching the convention used
// by other mini-infra collection endpoints (e.g., GET /api/environments). They
// are NOT wrapped in `{ success, data }`.

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface EgressPolicyListResponse extends PaginationMeta {
  policies: EgressPolicySummary[];
}

export type EgressPolicyDetailResponse = EgressPolicySummary & {
  rules: EgressRuleSummary[];
};

export interface EgressRuleListResponse {
  rules: EgressRuleSummary[];
}

export interface EgressEventListResponse extends PaginationMeta {
  events: EgressEventBroadcast[];
}

// ====================
// Query parameter types
// ====================

export interface ListEgressPoliciesQuery {
  environmentId?: string;
  stackId?: string;
  archived?: boolean;
  page?: number;
  limit?: number;
}

export interface ListEgressEventsQuery {
  environmentId?: string;
  stackId?: string;
  policyId?: string;
  sourceServiceName?: string;
  action?: "allowed" | "blocked" | "observed";
  since?: string;
  until?: string;
  page?: number;
  limit?: number;
}

// ====================
// Read endpoint fetchers
// ====================

export async function listEgressPolicies(
  query: ListEgressPoliciesQuery = {},
): Promise<EgressPolicyListResponse> {
  const correlationId = generateCorrelationId();
  const url = new URL("/api/egress/policies", window.location.origin);

  if (query.environmentId) url.searchParams.set("environmentId", query.environmentId);
  if (query.stackId) url.searchParams.set("stackId", query.stackId);
  if (query.archived !== undefined) url.searchParams.set("archived", String(query.archived));
  if (query.page !== undefined) url.searchParams.set("page", String(query.page));
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch egress policies: ${response.statusText}`);
  }

  return response.json();
}

export async function getEgressPolicy(
  policyId: string,
): Promise<EgressPolicyDetailResponse> {
  const correlationId = generateCorrelationId();
  const response = await fetch(`/api/egress/policies/${policyId}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch egress policy: ${response.statusText}`);
  }

  return response.json();
}

export async function listEgressRules(
  policyId: string,
): Promise<EgressRuleListResponse> {
  const correlationId = generateCorrelationId();
  const response = await fetch(`/api/egress/policies/${policyId}/rules`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch egress rules: ${response.statusText}`);
  }

  return response.json();
}

export async function listEgressEvents(
  query: ListEgressEventsQuery = {},
): Promise<EgressEventListResponse> {
  const correlationId = generateCorrelationId();
  const url = new URL("/api/egress/events", window.location.origin);

  if (query.environmentId) url.searchParams.set("environmentId", query.environmentId);
  if (query.stackId) url.searchParams.set("stackId", query.stackId);
  if (query.policyId) url.searchParams.set("policyId", query.policyId);
  if (query.sourceServiceName)
    url.searchParams.set("sourceServiceName", query.sourceServiceName);
  if (query.action) url.searchParams.set("action", query.action);
  if (query.since) url.searchParams.set("since", query.since);
  if (query.until) url.searchParams.set("until", query.until);
  if (query.page !== undefined) url.searchParams.set("page", String(query.page));
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch egress events: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Per-policy events list. Use this instead of listEgressEvents() when you
 * want events for one specific policy — the cross-policy /events endpoint
 * silently ignores its policyId param.
 */
export type ListEgressEventsForPolicyQuery = Omit<
  ListEgressEventsQuery,
  "environmentId" | "stackId" | "policyId"
>;

export async function listEgressEventsForPolicy(
  policyId: string,
  query: ListEgressEventsForPolicyQuery = {},
): Promise<EgressEventListResponse> {
  const correlationId = generateCorrelationId();
  const url = new URL(
    `/api/egress/policies/${policyId}/events`,
    window.location.origin,
  );

  if (query.action) url.searchParams.set("action", query.action);
  if (query.sourceServiceName)
    url.searchParams.set("sourceServiceName", query.sourceServiceName);
  if (query.since) url.searchParams.set("since", query.since);
  if (query.until) url.searchParams.set("until", query.until);
  if (query.page !== undefined) url.searchParams.set("page", String(query.page));
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch egress events for policy: ${response.statusText}`);
  }

  return response.json();
}

// ====================
// Mutation endpoint stubs (UI not wired in v1 — next slice)
// ====================

export interface PatchEgressPolicyBody {
  mode?: EgressMode;
  defaultAction?: EgressDefaultAction;
}

export interface CreateEgressRuleBody {
  pattern: string;
  action: "allow" | "block";
  targets?: string[];
}

export interface PatchEgressRuleBody {
  pattern?: string;
  action?: "allow" | "block";
  targets?: string[];
}

export async function patchEgressPolicy(
  policyId: string,
  body: PatchEgressPolicyBody,
): Promise<EgressPolicyDetailResponse> {
  const correlationId = generateCorrelationId();
  const response = await fetch(`/api/egress/policies/${policyId}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to update egress policy: ${response.statusText}`);
  }

  return response.json();
}

export async function createEgressRule(
  policyId: string,
  body: CreateEgressRuleBody,
): Promise<EgressRuleSummary> {
  const correlationId = generateCorrelationId();
  const response = await fetch(`/api/egress/policies/${policyId}/rules`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to create egress rule: ${response.statusText}`);
  }

  return response.json();
}

export async function patchEgressRule(
  ruleId: string,
  body: PatchEgressRuleBody,
): Promise<EgressRuleSummary> {
  const correlationId = generateCorrelationId();
  const response = await fetch(`/api/egress/rules/${ruleId}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to update egress rule: ${response.statusText}`);
  }

  return response.json();
}

export async function deleteEgressRule(ruleId: string): Promise<void> {
  const correlationId = generateCorrelationId();
  const response = await fetch(`/api/egress/rules/${ruleId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete egress rule: ${response.statusText}`);
  }
  // 204 No Content — no body to parse
}
