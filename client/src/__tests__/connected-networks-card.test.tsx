/**
 * Tests for `ConnectedNetworksCard`'s `findOwnMembership` matching logic.
 *
 * PR #479 review M2: an AdoptedWeb app's own membership row on a SHARED
 * network is recorded with `containerName` set (never `stackId` — the
 * server can't resolve one for an externally-managed container, see
 * `resolveMembershipTarget` in `server/src/services/networks/membership-store.ts`).
 * The card used to fall back to `network.memberships[0]` whenever no row's
 * `stackId` matched this app's own `stackId` — which, for an adopted app,
 * is EVERY row on a shared network, so it always displayed some OTHER
 * stack's provenance as if it were this app's own. These tests verify the
 * fix: match by `containerName` when the app's own adopted container names
 * are supplied via the `services` prop, and never borrow an unrelated row.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { ManagedNetworkView } from "@mini-infra/types";

const mockManagedNetworks = vi.fn<() => ManagedNetworkView[]>();

vi.mock("@/hooks/use-networks", () => ({
  useManagedNetworks: vi.fn(() => ({
    data: mockManagedNetworks(),
    isLoading: false,
    error: null,
  })),
  useReconcileNetworks: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useSetNetworkEnforceMemberships: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

import { ConnectedNetworksCard } from "@/app/applications/[id]/_components/connected-networks-card";

function renderCard(props: Partial<React.ComponentProps<typeof ConnectedNetworksCard>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const merged: React.ComponentProps<typeof ConnectedNetworksCard> = {
    stackId: "stack-mine",
    ...props,
  };
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ConnectedNetworksCard, merged),
    ),
  );
}

/** A shared "applications" network carrying rows for THIS app (adopted, `containerName`-keyed) and an unrelated OTHER stack's managed service. */
function sharedNetworkWithAdoptedAndOtherRow(): ManagedNetworkView {
  return {
    id: "net-shared",
    name: "prod-applications",
    scope: "environment",
    environmentId: "env-1",
    environmentName: "prod",
    purpose: "applications",
    driver: "bridge",
    dbStatus: "present",
    existence: "present",
    enforceMemberships: false,
    driftStatus: "synced",
    driftItemCount: 0,
    unattributedContainers: [],
    memberships: [
      {
        id: "membership-other",
        stackServiceId: "svc-other",
        stackId: "stack-OTHER",
        stackName: "some-other-app",
        serviceName: "web",
        source: "template",
        status: "connected",
        connectedContainers: [],
      },
      {
        id: "membership-mine",
        containerName: "legacy-adopted-container",
        source: "user",
        createdBy: "user-1",
        createdByName: "Alice",
        status: "connected",
        connectedContainers: [],
      },
    ],
  };
}

describe("ConnectedNetworksCard — own-membership matching (PR #479 review M2)", () => {
  it("shows the adopted app's OWN provenance (by containerName) on a shared network, not another stack's", async () => {
    mockManagedNetworks.mockReturnValue([sharedNetworkWithAdoptedAndOtherRow()]);

    renderCard({
      stackId: "stack-mine",
      services: [
        {
          id: "svc-mine",
          adoptedContainer: { containerName: "legacy-adopted-container", listeningPort: 8080 },
        },
      ],
    });

    // The adopted app's own row is `source: 'user'`, created by Alice —
    // never the other stack's `template` row.
    expect(await screen.findByText("User")).toBeTruthy();
    expect(screen.getByText("by Alice")).toBeTruthy();
    expect(screen.queryByText("Template")).toBeNull();
  });

  it("renders no source/creator badge when this app's own row can't be identified, rather than borrowing an unrelated one", async () => {
    mockManagedNetworks.mockReturnValue([sharedNetworkWithAdoptedAndOtherRow()]);

    // No `services` supplied at all — the card has no way to know this
    // app's own adopted container name, so it must not guess.
    renderCard({ stackId: "stack-mine" });

    await screen.findByText("prod-applications");
    // Neither the other stack's `Template` badge nor the adopted row's
    // `User` badge should render — there is no honest match.
    expect(screen.queryByText("Template")).toBeNull();
    expect(screen.queryByText("User")).toBeNull();
  });

  it("still matches a managed service's own row on a shared network via stackId", async () => {
    const network: ManagedNetworkView = {
      ...sharedNetworkWithAdoptedAndOtherRow(),
      memberships: [
        {
          id: "membership-other",
          stackServiceId: "svc-other",
          stackId: "stack-OTHER",
          stackName: "some-other-app",
          serviceName: "web",
          source: "template",
          status: "connected",
          connectedContainers: [],
        },
        {
          id: "membership-mine-managed",
          stackServiceId: "svc-mine",
          stackId: "stack-mine",
          stackName: "my-app",
          serviceName: "web",
          source: "egress",
          status: "connected",
          connectedContainers: [],
        },
      ],
    };
    mockManagedNetworks.mockReturnValue([network]);

    renderCard({ stackId: "stack-mine" });

    expect(await screen.findByText("Egress")).toBeTruthy();
    expect(screen.queryByText("Template")).toBeNull();
  });

  it("uses memberships[0] for a stack-owned (private-by-construction) network", async () => {
    const network: ManagedNetworkView = {
      id: "net-own",
      name: "my-app_default",
      scope: "stack",
      stackId: "stack-mine",
      stackName: "my-app",
      purpose: "default",
      driver: "bridge",
      dbStatus: "present",
      existence: "present",
      enforceMemberships: false,
      driftStatus: "synced",
      driftItemCount: 0,
      unattributedContainers: [],
      memberships: [
        {
          id: "membership-own",
          stackServiceId: "svc-mine",
          stackId: "stack-mine",
          stackName: "my-app",
          serviceName: "web",
          source: "template",
          status: "connected",
          connectedContainers: [],
        },
      ],
    };
    mockManagedNetworks.mockReturnValue([network]);

    renderCard({ stackId: "stack-mine" });

    expect(await screen.findByText("Template")).toBeTruthy();
  });
});
