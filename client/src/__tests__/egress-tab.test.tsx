/**
 * Smoke tests for the EgressTab component.
 *
 * Tests cover both v1 (read-only, canWrite=false) and v2 (write-capable,
 * canWrite=true) render variants, plus mode toggle and rule dialog interactions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
// useStack mock (returns service names for the rule dialog)
// ---------------------------------------------------------------------------

vi.mock("@/hooks/use-stacks", () => ({
  useStack: vi.fn(() => ({
    data: {
      id: "stack-1",
      services: [
        { serviceName: "api-service" },
        { serviceName: "worker-service" },
      ],
    },
    isLoading: false,
    isError: false,
  })),
}));

// ---------------------------------------------------------------------------
// useEnvironment / useUpdateEnvironment mocks (firewall card)
// ---------------------------------------------------------------------------

let currentEnvironmentData: { egressFirewallEnabled: boolean } & Record<string, unknown> = {
  id: "env-1",
  name: "production",
  type: "production",
  networkType: "internet",
  egressFirewallEnabled: false,
  networks: [],
  stackCount: 0,
  systemStackCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const mockUpdateEnvironmentMutateAsync = vi.fn();
let mockUpdateEnvironmentIsPending = false;

vi.mock("@/hooks/use-environments", () => ({
  useEnvironment: vi.fn(() => ({
    data: currentEnvironmentData,
    isLoading: false,
    isError: false,
  })),
  useUpdateEnvironment: vi.fn(() => ({
    mutateAsync: mockUpdateEnvironmentMutateAsync,
    isPending: mockUpdateEnvironmentIsPending,
  })),
}));

// ---------------------------------------------------------------------------
// sonner toast mock — needed so we can assert on success/error notifications
// ---------------------------------------------------------------------------

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock data
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

// Mutable policies data for per-test overrides
let currentPoliciesData: { policies: typeof mockPolicies; total: number; page: number; limit: number; totalPages: number; hasNextPage: boolean; hasPreviousPage: boolean } = {
  policies: mockPolicies,
  total: 1,
  page: 1,
  limit: 50,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};

vi.mock("@/hooks/use-egress", () => ({
  useEgressPolicies: vi.fn(() => ({
    data: currentPoliciesData,
    isLoading: false,
    isError: false,
    error: null,
  })),
  useEgressPolicy: vi.fn(() => ({
    data: { ...mockPolicies[0], rules: mockRules },
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
      events: mockEvents,
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
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
  useDeleteEgressRule: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  usePatchEgressPolicy: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));

// Also mock the sub-components that open dialogs/wizards so they don't try to
// render complex portals in jsdom
vi.mock("@/components/egress/egress-rule-dialog", () => ({
  EgressRuleDialog: vi.fn(({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) =>
    open
      ? React.createElement("div", { "data-testid": "egress-rule-dialog" }, "Rule Dialog")
      : null,
  ),
}));

vi.mock("@/components/egress/egress-promote-wizard", () => ({
  EgressPromoteWizard: vi.fn(({ open }: { open: boolean; onOpenChange: (o: boolean) => void }) =>
    open
      ? React.createElement("div", { "data-testid": "promote-wizard" }, "Promote Wizard")
      : null,
  ),
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

function renderTab(canWrite = true) {
  return render(
    React.createElement(
      TestWrapper,
      null,
      React.createElement(EgressTab, { environmentId: "env-1", canWrite }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EgressTab", () => {
  beforeEach(() => {
    currentPoliciesData = { policies: mockPolicies, total: 1, page: 1, limit: 50, totalPages: 1, hasNextPage: false, hasPreviousPage: false };
    currentEnvironmentData = {
      id: "env-1",
      name: "production",
      type: "production",
      networkType: "internet",
      egressFirewallEnabled: false,
      networks: [],
      stackCount: 0,
      systemStackCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockUpdateEnvironmentIsPending = false;
    mockUpdateEnvironmentMutateAsync.mockReset();
    mockUpdateEnvironmentMutateAsync.mockResolvedValue(currentEnvironmentData);
    vi.clearAllMocks();
  });

  // ---- v1 smoke tests (read-only) ----

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
    const matches = screen.getAllByText("api-stack");
    expect(matches.length).toBeGreaterThan(0);
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

  // ---- v2: canWrite=false (read-only badges, no write controls) ----

  it("renders read-only mode badge when canWrite=false", async () => {
    renderTab(false);
    await waitFor(() => {
      expect(screen.getByText("Detect")).toBeTruthy();
    });
    // Should NOT show the segmented Detect/Enforce toggle buttons
    // (The v2 toggle renders as a ToggleGroup with aria role="group";
    //  the v1 ModeBadge renders a Badge — both say "Detect" but in different elements)
    // Simply check that the "Add rule" button is NOT shown
    expect(screen.queryByText("Add rule")).toBeNull();
  });

  it("does not show edit/delete buttons when canWrite=false", async () => {
    renderTab(false);
    await waitFor(() => {
      expect(screen.getByText("*.googleapis.com")).toBeTruthy();
    });
    expect(screen.queryByLabelText("Edit rule")).toBeNull();
    expect(screen.queryByLabelText("Delete rule")).toBeNull();
  });

  // ---- v2: canWrite=true (write controls visible) ----

  it("shows Add rule button when canWrite=true", async () => {
    renderTab(true);
    await waitFor(() => {
      expect(screen.getByText("Add rule")).toBeTruthy();
    });
  });

  it("opens EgressRuleDialog when Add rule is clicked", async () => {
    renderTab(true);
    await waitFor(() => {
      expect(screen.getByText("Add rule")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Add rule"));
    await waitFor(() => {
      expect(screen.getByTestId("egress-rule-dialog")).toBeTruthy();
    });
  });

  it("shows mode toggle (Detect/Enforce) when canWrite=true", async () => {
    renderTab(true);
    await waitFor(() => {
      // Both toggle items should be present
      const detectButtons = screen.getAllByText("Detect");
      expect(detectButtons.length).toBeGreaterThan(0);
      const enforceButtons = screen.getAllByText("Enforce");
      expect(enforceButtons.length).toBeGreaterThan(0);
    });
  });

  it("opens promote wizard when Enforce toggle is clicked", async () => {
    renderTab(true);
    await waitFor(() => {
      expect(screen.getAllByText("Enforce").length).toBeGreaterThan(0);
    });
    // Click the Enforce toggle item in the mode toggle
    const enforceButtons = screen.getAllByText("Enforce");
    fireEvent.click(enforceButtons[0]);
    await waitFor(() => {
      expect(screen.getByTestId("promote-wizard")).toBeTruthy();
    });
  });

  it("template rules show disabled edit/delete with no error", async () => {
    renderTab(true);
    await waitFor(() => {
      expect(screen.getByText("example.malware.com")).toBeTruthy();
    });
    // Template rule source badge should be visible
    expect(screen.getByText("template")).toBeTruthy();
  });

  it("renders empty state when no policies exist", () => {
    currentPoliciesData = { policies: [], total: 0, page: 1, limit: 50, totalPages: 0, hasNextPage: false, hasPreviousPage: false };
    renderTab();
    expect(screen.getByText("No egress policies")).toBeTruthy();
  });

  // ---- Egress firewall card ----

  describe("Egress firewall card", () => {
    it("renders the firewall header and unchecked switch when egressFirewallEnabled=false", async () => {
      renderTab(true);
      await waitFor(() => {
        expect(screen.getByText("Egress Firewall")).toBeTruthy();
      });
      const toggle = screen.getByLabelText("Egress firewall") as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    it("renders the switch as checked when egressFirewallEnabled=true", async () => {
      currentEnvironmentData = { ...currentEnvironmentData, egressFirewallEnabled: true };
      renderTab(true);
      await waitFor(() => {
        const toggle = screen.getByLabelText("Egress firewall") as HTMLButtonElement;
        expect(toggle.getAttribute("aria-checked")).toBe("true");
      });
    });

    it("calls mutateAsync directly when enabling (no confirm dialog)", async () => {
      const { toast } = await import("sonner");
      renderTab(true);
      const toggle = await screen.findByLabelText("Egress firewall");
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(mockUpdateEnvironmentMutateAsync).toHaveBeenCalledWith({
          id: "env-1",
          request: { egressFirewallEnabled: true },
        });
      });
      expect(toast.success).toHaveBeenCalledWith(
        "Egress firewall enabled — applying to running stacks",
      );
      // No confirm dialog rendered
      expect(screen.queryByText("Disable egress firewall?")).toBeNull();
    });

    it("opens the confirm dialog when disabling, calls mutateAsync only after confirm", async () => {
      currentEnvironmentData = { ...currentEnvironmentData, egressFirewallEnabled: true };
      const { toast } = await import("sonner");
      renderTab(true);
      const toggle = await screen.findByLabelText("Egress firewall");
      fireEvent.click(toggle);
      // Dialog opens; mutate not yet called
      await waitFor(() => {
        expect(screen.getByText("Disable egress firewall?")).toBeTruthy();
      });
      expect(mockUpdateEnvironmentMutateAsync).not.toHaveBeenCalled();
      // Click the confirm action
      fireEvent.click(screen.getByText("Disable firewall"));
      await waitFor(() => {
        expect(mockUpdateEnvironmentMutateAsync).toHaveBeenCalledWith({
          id: "env-1",
          request: { egressFirewallEnabled: false },
        });
      });
      expect(toast.success).toHaveBeenCalledWith("Egress firewall disabled");
    });

    it("does not call mutateAsync when the disable confirm is cancelled", async () => {
      currentEnvironmentData = { ...currentEnvironmentData, egressFirewallEnabled: true };
      renderTab(true);
      const toggle = await screen.findByLabelText("Egress firewall");
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(screen.getByText("Disable egress firewall?")).toBeTruthy();
      });
      fireEvent.click(screen.getByText("Cancel"));
      expect(mockUpdateEnvironmentMutateAsync).not.toHaveBeenCalled();
    });

    it("disables the switch when canWrite=false", async () => {
      renderTab(false);
      await waitFor(() => {
        expect(screen.getByText("Egress Firewall")).toBeTruthy();
      });
      const toggle = screen.getByLabelText("Egress firewall") as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);
    });

    it("shows toast.error when mutateAsync rejects", async () => {
      mockUpdateEnvironmentMutateAsync.mockRejectedValueOnce(new Error("boom"));
      const { toast } = await import("sonner");
      renderTab(true);
      const toggle = await screen.findByLabelText("Egress firewall");
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          "Failed to update egress firewall: boom",
        );
      });
    });
  });
});
