/**
 * Smoke test for the EgressTab component.
 *
 * Verifies it renders without crashing, shows policy data, rules, and
 * the traffic feed section when mocked data is provided.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { EgressTab } from "@/components/egress/egress-tab";

// ---------------------------------------------------------------------------
// Socket mock
// ---------------------------------------------------------------------------

vi.mock("@/hooks/use-socket", () => ({
  useSocket: vi.fn(() => ({
    socket: {},
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  })),
  useSocketChannel: vi.fn(),
  useSocketEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Hook mocks
// ---------------------------------------------------------------------------

const mockPolicies = [
  {
    id: "policy-1",
    stackId: "stack-1",
    stackNameSnapshot: "api-stack",
    environmentId: "env-1",
    environmentNameSnapshot: "production",
    mode: "detect" as const,
    defaultAction: "allow" as const,
    version: 2,
    appliedVersion: 1, // drift
    archivedAt: null,
    archivedReason: null,
  },
];

const mockRules = [
  {
    id: "rule-1",
    policyId: "policy-1",
    pattern: "*.googleapis.com",
    action: "allow" as const,
    source: "user" as const,
    targets: [],
    hits: 100,
    lastHitAt: null,
  },
  {
    id: "rule-2",
    policyId: "policy-1",
    pattern: "example.malware.com",
    action: "block" as const,
    source: "template" as const,
    targets: ["api-service"],
    hits: 3,
    lastHitAt: "2024-01-15T12:00:00Z",
  },
];

const mockEvents = [
  {
    id: "evt-1",
    policyId: "policy-1",
    occurredAt: new Date().toISOString(),
    sourceContainerId: "ctr-1",
    sourceStackId: "stack-1",
    sourceServiceName: "api-service",
    destination: "api.stripe.com",
    matchedPattern: "*.stripe.com",
    action: "allowed" as const,
    protocol: "sni" as const,
    mergedHits: 5,
    stackNameSnapshot: "api-stack",
    environmentNameSnapshot: "production",
    environmentId: "env-1",
  },
];

// Keep a mutable ref so individual tests can override policy data
let currentPoliciesData = {
  success: true,
  data: mockPolicies,
};

vi.mock("@/hooks/use-egress", () => ({
  useEgressPolicies: vi.fn(() => ({
    data: currentPoliciesData,
    isLoading: false,
    isError: false,
    error: null,
  })),
  useEgressPolicy: vi.fn(() => ({
    data: {
      success: true,
      data: { ...mockPolicies[0], rules: mockRules },
    },
    isLoading: false,
    isError: false,
  })),
  useEgressGatewayHealth: vi.fn(() => ({
    environmentId: "env-1",
    gatewayIp: "10.0.0.1",
    ok: true,
    rulesVersion: 2,
    appliedRulesVersion: 2,
    containerMapVersion: 1,
    appliedContainerMapVersion: 1,
    upstream: { servers: [], lastSuccessAt: null, lastFailureAt: null },
  })),
  useEgressEvents: vi.fn(() => ({
    data: {
      success: true,
      data: mockEvents,
      pagination: { totalCount: 1, page: 1, limit: 50, offset: 0 },
    },
    isLoading: false,
    isError: false,
    error: null,
    liveEvents: [],
    clearLiveEvents: vi.fn(),
  })),
  useEgressEventFilters: vi.fn(() => ({
    filters: { page: 1, limit: 50 },
    updateFilter: vi.fn(),
    resetFilters: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderTab() {
  return render(
    React.createElement(
      TestWrapper,
      null,
      React.createElement(EgressTab, { environmentId: "env-1" }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EgressTab", () => {
  beforeEach(() => {
    currentPoliciesData = { success: true, data: mockPolicies };
  });

  it("renders without crashing", () => {
    const { container } = renderTab();
    expect(container).toBeTruthy();
  });

  it("shows the Egress Policies heading", () => {
    renderTab();
    expect(screen.getByText("Egress Policies")).toBeTruthy();
  });

  it("shows the stack name from the policy", () => {
    renderTab();
    // "api-stack" appears both in the policy card header and in the traffic table
    const matches = screen.getAllByText("api-stack");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("shows the Detect mode badge", () => {
    renderTab();
    expect(screen.getByText("Detect")).toBeTruthy();
  });

  it("shows rules in the rules table", async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("*.googleapis.com")).toBeTruthy();
      expect(screen.getByText("example.malware.com")).toBeTruthy();
    });
  });

  it("shows the Traffic Feed heading", () => {
    renderTab();
    expect(screen.getByText("Traffic Feed")).toBeTruthy();
  });

  it("shows traffic events in the table", async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("api.stripe.com")).toBeTruthy();
    });
  });
});
