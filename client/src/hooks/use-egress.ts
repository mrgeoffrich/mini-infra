/**
 * TanStack Query hooks for the Egress Firewall feature.
 *
 * Patterns mirror useContainers.ts / use-events.ts exactly:
 * - No polling when socket is connected; fall back to polling when disconnected
 * - useSocketChannel(Channel.EGRESS) subscribes on mount / unsubscribes on unmount
 * - useSocketEvent() listens for server events and invalidates the relevant query keys
 * - refetchOnReconnect: true catches events missed during disconnection
 *
 * Live event feed: EGRESS_EVENT broadcasts are prepended to the in-memory list
 * optimistically (no full re-fetch on every event). The list is capped at
 * MAX_LIVE_EGRESS_EVENTS entries; older events are only accessible via pagination.
 */

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState, useCallback, useMemo } from "react";
import {
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import type {
  EgressEventBroadcast,
  EgressGatewayHealthEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import {
  listEgressPolicies,
  getEgressPolicy,
  listEgressRules,
  listEgressEvents,
  patchEgressPolicy,
  createEgressRule,
  patchEgressRule,
  deleteEgressRule,
} from "@/api/egress";
import type {
  ListEgressPoliciesQuery,
  ListEgressEventsQuery,
  PatchEgressPolicyBody,
  CreateEgressRuleBody,
  PatchEgressRuleBody,
} from "@/api/egress";

const POLL_INTERVAL_DISCONNECTED = 10000; // 10 s when socket not connected

/**
 * Maximum events to keep in the in-memory live feed before older ones
 * fall off (only accessible via server-paginated history).
 */
const MAX_LIVE_EGRESS_EVENTS = 200;

// ====================
// useEgressPolicies
// ====================

export interface UseEgressPoliciesOptions {
  query?: ListEgressPoliciesQuery;
  enabled?: boolean;
}

export function useEgressPolicies(options: UseEgressPoliciesOptions = {}) {
  const { query = {}, enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval = connected ? false : POLL_INTERVAL_DISCONNECTED;

  // Subscribe to the egress channel so the server routes events to this client
  useSocketChannel(Channel.EGRESS, enabled);

  // Policy updated → invalidate the policies list and any per-policy cache
  useSocketEvent(
    ServerEvent.EGRESS_POLICY_UPDATED,
    (data) => {
      queryClient.invalidateQueries({ queryKey: ["egressPolicies"] });
      queryClient.invalidateQueries({ queryKey: ["egressPolicy", data.policyId] });
    },
    enabled,
  );

  // Rule mutation → invalidate the policies list (it embeds rules in detail view)
  useSocketEvent(
    ServerEvent.EGRESS_RULE_MUTATION,
    (data) => {
      queryClient.invalidateQueries({ queryKey: ["egressPolicies"] });
      queryClient.invalidateQueries({ queryKey: ["egressPolicy", data.policyId] });
      queryClient.invalidateQueries({ queryKey: ["egressRules", data.policyId] });
    },
    enabled,
  );

  return useQuery({
    queryKey: ["egressPolicies", query],
    queryFn: () => listEgressPolicies(query),
    enabled,
    refetchInterval,
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized")
      ) {
        return false;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
  });
}

// ====================
// useEgressPolicy (single policy with embedded rules)
// ====================

export interface UseEgressPolicyOptions {
  enabled?: boolean;
}

export function useEgressPolicy(
  policyId: string,
  options: UseEgressPolicyOptions = {},
) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval = connected ? false : POLL_INTERVAL_DISCONNECTED;

  useSocketChannel(Channel.EGRESS, enabled && !!policyId);

  useSocketEvent(
    ServerEvent.EGRESS_POLICY_UPDATED,
    (data) => {
      if (data.policyId === policyId) {
        queryClient.invalidateQueries({ queryKey: ["egressPolicy", policyId] });
      }
    },
    enabled && !!policyId,
  );

  useSocketEvent(
    ServerEvent.EGRESS_RULE_MUTATION,
    (data) => {
      if (data.policyId === policyId) {
        queryClient.invalidateQueries({ queryKey: ["egressPolicy", policyId] });
        queryClient.invalidateQueries({ queryKey: ["egressRules", policyId] });
      }
    },
    enabled && !!policyId,
  );

  return useQuery({
    queryKey: ["egressPolicy", policyId],
    queryFn: () => getEgressPolicy(policyId),
    enabled: enabled && !!policyId,
    refetchInterval,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized") ||
        error.message.includes("404")
      ) {
        return false;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
  });
}

// ====================
// useEgressRules (standalone rule list for a policy)
// ====================

export interface UseEgressRulesOptions {
  enabled?: boolean;
}

export function useEgressRules(
  policyId: string,
  options: UseEgressRulesOptions = {},
) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval = connected ? false : POLL_INTERVAL_DISCONNECTED;

  useSocketChannel(Channel.EGRESS, enabled && !!policyId);

  useSocketEvent(
    ServerEvent.EGRESS_RULE_MUTATION,
    (data) => {
      if (data.policyId === policyId) {
        queryClient.invalidateQueries({ queryKey: ["egressRules", policyId] });
      }
    },
    enabled && !!policyId,
  );

  return useQuery({
    queryKey: ["egressRules", policyId],
    queryFn: () => listEgressRules(policyId),
    enabled: enabled && !!policyId,
    refetchInterval,
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized")
      ) {
        return false;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
  });
}

// ====================
// useEgressEvents (paginated history + live prepend)
// ====================

export interface UseEgressEventsOptions {
  query?: ListEgressEventsQuery;
  enabled?: boolean;
}

/**
 * Returns the server-paginated history for the current filter set, plus a
 * `liveEvents` array that is prepended to in real-time (without re-fetching
 * the full page) as EGRESS_EVENT broadcasts arrive.  Consumers should render
 * liveEvents first, then the paged history, deduplicating on `id`.
 *
 * The live list is reset whenever the query params change (new filter applied)
 * so stale pre-pended rows don't bleed between filter states.
 */
export function useEgressEvents(options: UseEgressEventsOptions = {}) {
  const { query = {}, enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  // Live events prepended from socket broadcasts.
  // We pair them with the query key they were captured under so that when the
  // consumer changes filters, stale live rows are excluded without needing
  // a setState-in-effect (which the linter prohibits).
  const currentQueryKey = useMemo(() => JSON.stringify(query), [query]);
  const [liveEventsBucket, setLiveEventsBucket] = useState<{
    key: string;
    events: EgressEventBroadcast[];
  }>({ key: currentQueryKey, events: [] });

  // If the query key has changed, derive an empty live list immediately
  const liveEvents =
    liveEventsBucket.key === currentQueryKey ? liveEventsBucket.events : [];

  const refetchInterval = connected ? false : POLL_INTERVAL_DISCONNECTED;

  useSocketChannel(Channel.EGRESS, enabled);

  // Prepend new events to the live feed — filter by environmentId if set
  useSocketEvent(
    ServerEvent.EGRESS_EVENT,
    (data) => {
      if (query.environmentId && data.environmentId !== query.environmentId) return;
      if (query.policyId && data.policyId !== query.policyId) return;
      if (query.action && data.action !== query.action) return;

      setLiveEventsBucket((prev) => {
        // If the active query key changed since we started receiving, start fresh
        const events = prev.key === currentQueryKey ? prev.events : [];
        // Deduplicate — socket may deliver the same event twice on reconnect
        if (events.some((e) => e.id === data.id)) return prev;
        const next = [data, ...events];
        return {
          key: currentQueryKey,
          events: next.length > MAX_LIVE_EGRESS_EVENTS
            ? next.slice(0, MAX_LIVE_EGRESS_EVENTS)
            : next,
        };
      });

      // Also invalidate the history query so pagination totals stay accurate
      queryClient.invalidateQueries({ queryKey: ["egressEvents"] });
    },
    enabled,
  );

  const historyQuery = useQuery({
    queryKey: ["egressEvents", query],
    queryFn: () => listEgressEvents(query),
    enabled,
    refetchInterval,
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized")
      ) {
        return false;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
  });

  return {
    ...historyQuery,
    liveEvents,
    clearLiveEvents: () =>
      setLiveEventsBucket({ key: currentQueryKey, events: [] }),
  };
}

// ====================
// useEgressGatewayHealth — stash latest gateway health snapshot per env
// ====================

/**
 * Holds the most-recent EGRESS_GATEWAY_HEALTH snapshot for a given env.
 * There is no REST endpoint for this — it is socket-only.
 */
export function useEgressGatewayHealth(environmentId: string | null | undefined) {
  const [health, setHealth] = useState<EgressGatewayHealthEvent | null>(null);
  const enabled = !!environmentId;

  useSocketChannel(Channel.EGRESS, enabled);

  useSocketEvent(
    ServerEvent.EGRESS_GATEWAY_HEALTH,
    (data) => {
      if (data.environmentId === environmentId) {
        setHealth(data);
      }
    },
    enabled,
  );

  return health;
}

// ====================
// useEgressEventFilters
// ====================

export interface EgressEventFiltersState {
  action?: "allowed" | "blocked" | "observed";
  since?: string; // ISO string
  until?: string; // ISO string
  destination?: string; // free-text search
  page: number;
  limit: number;
}

export function useEgressEventFilters(
  initial: Partial<EgressEventFiltersState> = {},
) {
  const [filters, setFilters] = useState<EgressEventFiltersState>({
    page: 1,
    limit: 50,
    ...initial,
  });

  const updateFilter = useCallback(
    <K extends keyof EgressEventFiltersState>(
      key: K,
      value: EgressEventFiltersState[K],
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        page: key === "page" ? (value as number) : 1,
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({ page: 1, limit: 50, ...initial });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { filters, updateFilter, resetFilters };
}

// ====================
// Mutation hooks (v2 — with optimistic updates, cache invalidation, and egressEvents)
// ====================

export function usePatchEgressPolicy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      policyId,
      body,
    }: {
      policyId: string;
      body: PatchEgressPolicyBody;
    }) => patchEgressPolicy(policyId, body),

    // Optimistic update: immediately reflect mode/defaultAction changes on the
    // policy detail cache so the UI feels instant.
    onMutate: async ({ policyId, body }) => {
      await queryClient.cancelQueries({ queryKey: ["egressPolicy", policyId] });
      const previous = queryClient.getQueryData(["egressPolicy", policyId]);
      queryClient.setQueryData(["egressPolicy", policyId], (old: unknown) => {
        if (!old || typeof old !== "object") return old;
        const prev = old as { data: Record<string, unknown> };
        return { ...prev, data: { ...prev.data, ...body } };
      });
      return { previous, policyId };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(
          ["egressPolicy", context.policyId],
          context.previous,
        );
      }
    },

    onSettled: (_, __, { policyId }) => {
      queryClient.invalidateQueries({ queryKey: ["egressPolicies"] });
      queryClient.invalidateQueries({ queryKey: ["egressPolicy", policyId] });
    },
  });
}

export function useCreateEgressRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      policyId,
      body,
    }: {
      policyId: string;
      body: CreateEgressRuleBody;
    }) => createEgressRule(policyId, body),

    onSettled: (_, __, { policyId }) => {
      queryClient.invalidateQueries({ queryKey: ["egressRules", policyId] });
      queryClient.invalidateQueries({ queryKey: ["egressPolicy", policyId] });
      // A new rule can change matchedPattern on existing events
      queryClient.invalidateQueries({ queryKey: ["egressEvents"] });
    },
  });
}

export function usePatchEgressRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: {
      ruleId: string;
      policyId: string;
      body: PatchEgressRuleBody;
    }) => patchEgressRule(args.ruleId, args.body),

    // Optimistic update: patch the rule in-place in the policy detail cache
    onMutate: async ({ ruleId, policyId, body }) => {
      await queryClient.cancelQueries({ queryKey: ["egressPolicy", policyId] });
      const previous = queryClient.getQueryData(["egressPolicy", policyId]);
      queryClient.setQueryData(["egressPolicy", policyId], (old: unknown) => {
        if (!old || typeof old !== "object") return old;
        const prev = old as { data: { rules?: Array<{ id: string } & Record<string, unknown>> } };
        return {
          ...prev,
          data: {
            ...prev.data,
            rules: prev.data.rules?.map((r) =>
              r.id === ruleId ? { ...r, ...body } : r,
            ),
          },
        };
      });
      return { previous, policyId };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(
          ["egressPolicy", context.policyId],
          context.previous,
        );
      }
    },

    onSettled: (_, __, { policyId }) => {
      queryClient.invalidateQueries({ queryKey: ["egressRules", policyId] });
      queryClient.invalidateQueries({ queryKey: ["egressPolicy", policyId] });
      // Pattern rename can affect matchedPattern on events
      queryClient.invalidateQueries({ queryKey: ["egressEvents"] });
    },
  });
}

export function useDeleteEgressRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: { ruleId: string; policyId: string }) =>
      deleteEgressRule(args.ruleId),

    // Optimistic update: remove the rule from the policy detail cache
    onMutate: async ({ ruleId, policyId }) => {
      await queryClient.cancelQueries({ queryKey: ["egressPolicy", policyId] });
      const previous = queryClient.getQueryData(["egressPolicy", policyId]);
      queryClient.setQueryData(["egressPolicy", policyId], (old: unknown) => {
        if (!old || typeof old !== "object") return old;
        const prev = old as { data: { rules?: Array<{ id: string }> } };
        return {
          ...prev,
          data: {
            ...prev.data,
            rules: prev.data.rules?.filter((r) => r.id !== ruleId),
          },
        };
      });
      return { previous, policyId };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(
          ["egressPolicy", context.policyId],
          context.previous,
        );
      }
    },

    onSettled: (_, __, { policyId }) => {
      queryClient.invalidateQueries({ queryKey: ["egressRules", policyId] });
      queryClient.invalidateQueries({ queryKey: ["egressPolicy", policyId] });
      queryClient.invalidateQueries({ queryKey: ["egressEvents"] });
    },
  });
}

// Re-export query param types for convenience
export type {
  ListEgressPoliciesQuery,
  ListEgressEventsQuery,
  PatchEgressPolicyBody,
  CreateEgressRuleBody,
  PatchEgressRuleBody,
};
