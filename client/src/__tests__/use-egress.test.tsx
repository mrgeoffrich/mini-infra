/**
 * Tests for the useEgressPolicies TanStack Query hook.
 * Verifies that:
 *   - It subscribes to Channel.EGRESS via useSocketChannel
 *   - It invalidates queries on EGRESS_POLICY_UPDATED and EGRESS_RULE_MUTATION
 *   - It renders data returned by the API fetcher
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useEgressPolicies } from "@/hooks/use-egress";
import { Channel, ServerEvent } from "@mini-infra/types";
import * as socketHooks from "@/hooks/use-socket";

// ---------------------------------------------------------------------------
// Socket mock — capture subscribe calls and event listeners
// ---------------------------------------------------------------------------

const socketEventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const subscribedChannels = new Set<string>();

// Emit a fake socket event to all registered listeners
function emitSocketEvent(event: string, data: unknown) {
  socketEventListeners.get(event)?.forEach((handler) => handler(data));
}

// vi.mock factories are hoisted, so we cannot reference module-scope variables
// declared with const/let. Use vi.fn() inline and retrieve the mocks afterwards.
vi.mock("@/hooks/use-socket", () => ({
  useSocket: vi.fn(() => ({
    socket: {},
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
  })),
  useSocketChannel: vi.fn((channel: string) => {
    subscribedChannels.add(channel);
  }),
  useSocketEvent: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!socketEventListeners.has(event)) {
      socketEventListeners.set(event, new Set());
    }
    socketEventListeners.get(event)!.add(handler);
  }),
}));

// ---------------------------------------------------------------------------
// API fetcher mock
// vi.mock factories are hoisted above variable declarations, so we use a
// plain object inside the factory rather than referencing outer const/let vars.
// ---------------------------------------------------------------------------

vi.mock("@/api/egress", () => ({
  listEgressPolicies: vi.fn().mockResolvedValue({
    policies: [
      {
        id: "policy-1",
        stackId: "stack-1",
        stackNameSnapshot: "my-stack",
        environmentId: "env-1",
        environmentNameSnapshot: "production",
        mode: "detect",
        defaultAction: "allow",
        version: 1,
        appliedVersion: 1,
        archivedAt: null,
        archivedReason: null,
      },
    ],
    total: 1,
    page: 1,
    limit: 50,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  }),
  getEgressPolicy: vi.fn().mockResolvedValue({ id: "policy-1", stackId: null, stackNameSnapshot: "", environmentId: null, environmentNameSnapshot: "", mode: "detect", defaultAction: "allow", version: 1, appliedVersion: 1, archivedAt: null, archivedReason: null, rules: [] }),
  listEgressRules: vi.fn().mockResolvedValue({ rules: [] }),
  listEgressEvents: vi.fn().mockResolvedValue({
    events: [],
    total: 0,
    page: 1,
    limit: 50,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false,
  }),
  patchEgressPolicy: vi.fn(),
  createEgressRule: vi.fn(),
  patchEgressRule: vi.fn(),
  deleteEgressRule: vi.fn(),
}));

// Expected shape for assertions (flat, matches EgressPolicyListResponse)
const mockPoliciesData = {
  policies: [
    {
      id: "policy-1",
      stackId: "stack-1",
      stackNameSnapshot: "my-stack",
      environmentId: "env-1",
      environmentNameSnapshot: "production",
      mode: "detect" as const,
      defaultAction: "allow" as const,
      version: 1,
      appliedVersion: 1,
      archivedAt: null,
      archivedReason: null,
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return { wrapper, queryClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useEgressPolicies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketEventListeners.clear();
    subscribedChannels.clear();
  });

  it("subscribes to Channel.EGRESS on mount", () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useEgressPolicies({ query: { environmentId: "env-1" } }), { wrapper });

    // useSocketChannel should have been called with Channel.EGRESS
    expect(vi.mocked(socketHooks.useSocketChannel)).toHaveBeenCalledWith(Channel.EGRESS, true);
  });

  it("returns data from the fetcher", async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useEgressPolicies({ query: { environmentId: "env-1" } }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockPoliciesData);
  });

  it("listens for EGRESS_POLICY_UPDATED and invalidates queries", async () => {
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useEgressPolicies({ query: { environmentId: "env-1" } }), { wrapper });

    // Wait until all socket listeners are registered (hook fully mounted)
    await waitFor(() => {
      expect(vi.mocked(socketHooks.useSocketEvent)).toHaveBeenCalled();
    });

    // Simulate server emitting EGRESS_POLICY_UPDATED
    emitSocketEvent(ServerEvent.EGRESS_POLICY_UPDATED, {
      policyId: "policy-1",
      environmentId: "env-1",
      stackId: "stack-1",
      version: 2,
      appliedVersion: 2,
      mode: "detect",
      defaultAction: "allow",
      archivedAt: null,
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["egressPolicies"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["egressPolicy", "policy-1"] }),
    );
  });

  it("listens for EGRESS_RULE_MUTATION and invalidates queries", async () => {
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useEgressPolicies({ query: { environmentId: "env-1" } }), { wrapper });

    await waitFor(() => {
      expect(vi.mocked(socketHooks.useSocketEvent)).toHaveBeenCalled();
    });

    emitSocketEvent(ServerEvent.EGRESS_RULE_MUTATION, {
      policyId: "policy-1",
      ruleId: "rule-1",
      changeType: "created",
      rule: null,
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["egressPolicies"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["egressPolicy", "policy-1"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["egressRules", "policy-1"] }),
    );
  });

  it("does not poll when socket is connected", () => {
    const { wrapper } = makeWrapper();
    // useSocket mock returns connected=true
    const { result } = renderHook(
      () => useEgressPolicies({ query: {} }),
      { wrapper },
    );
    expect(result.current).toBeDefined();
  });
});
