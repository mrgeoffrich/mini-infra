/**
 * Egress Firewall API client functions.
 *
 * All fetchers go through the shared `apiFetch` client. Egress list/detail
 * endpoints return flat envelopes matching the convention used by other
 * mini-infra collection endpoints (e.g., GET /api/environments) — they are
 * NOT wrapped in `{ success, data }` — so every call here passes
 * `unwrap: false` and returns the parsed body's own shape directly.
 */

import { ApiRoute } from "@mini-infra/types";
import type {
  EgressPolicySummary,
  EgressRuleSummary,
  EgressEventBroadcast,
  EgressMode,
  EgressDefaultAction,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// Response envelope types
// ====================

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
  const url = new URL(ApiRoute.egress.policies(), window.location.origin);

  if (query.environmentId) url.searchParams.set("environmentId", query.environmentId);
  if (query.stackId) url.searchParams.set("stackId", query.stackId);
  if (query.archived !== undefined) url.searchParams.set("archived", String(query.archived));
  if (query.page !== undefined) url.searchParams.set("page", String(query.page));
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));

  return apiFetch<EgressPolicyListResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "egress-policies",
  });
}

export async function getEgressPolicy(
  policyId: string,
): Promise<EgressPolicyDetailResponse> {
  return apiFetch<EgressPolicyDetailResponse>(ApiRoute.egress.policy(policyId), {
    unwrap: false,
    correlationIdPrefix: "egress-policy",
  });
}

export async function listEgressRules(
  policyId: string,
): Promise<EgressRuleListResponse> {
  return apiFetch<EgressRuleListResponse>(ApiRoute.egress.policyRules(policyId), {
    unwrap: false,
    correlationIdPrefix: "egress-rules",
  });
}

export async function listEgressEvents(
  query: ListEgressEventsQuery = {},
): Promise<EgressEventListResponse> {
  const url = new URL(ApiRoute.egress.events(), window.location.origin);

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

  return apiFetch<EgressEventListResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "egress-events",
  });
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
  const url = new URL(ApiRoute.egress.policyEvents(policyId), window.location.origin);

  if (query.action) url.searchParams.set("action", query.action);
  if (query.sourceServiceName)
    url.searchParams.set("sourceServiceName", query.sourceServiceName);
  if (query.since) url.searchParams.set("since", query.since);
  if (query.until) url.searchParams.set("until", query.until);
  if (query.page !== undefined) url.searchParams.set("page", String(query.page));
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));

  return apiFetch<EgressEventListResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "egress-events-policy",
  });
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
  return apiFetch<EgressPolicyDetailResponse>(ApiRoute.egress.policy(policyId), {
    method: "PATCH",
    body,
    unwrap: false,
    correlationIdPrefix: "egress-policy-patch",
  });
}

export async function createEgressRule(
  policyId: string,
  body: CreateEgressRuleBody,
): Promise<EgressRuleSummary> {
  return apiFetch<EgressRuleSummary>(ApiRoute.egress.policyRules(policyId), {
    method: "POST",
    body,
    unwrap: false,
    correlationIdPrefix: "egress-rule-create",
  });
}

export async function patchEgressRule(
  ruleId: string,
  body: PatchEgressRuleBody,
): Promise<EgressRuleSummary> {
  return apiFetch<EgressRuleSummary>(ApiRoute.egress.rule(ruleId), {
    method: "PATCH",
    body,
    unwrap: false,
    correlationIdPrefix: "egress-rule-patch",
  });
}

export async function deleteEgressRule(ruleId: string): Promise<void> {
  await apiFetch<void>(ApiRoute.egress.rule(ruleId), {
    method: "DELETE",
    unwrap: false,
    correlationIdPrefix: "egress-rule-delete",
  });
}
