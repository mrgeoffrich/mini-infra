/**
 * Tests for `findOwnMembership` — the Connected Networks card's logic for
 * picking THIS application's own membership row out of a network's full
 * membership list.
 *
 * PR #479 review M2: an AdoptedWeb app's own membership row on a SHARED
 * network is recorded with `containerName` set (never `stackId` — the server
 * can't resolve one for an externally-managed container, see
 * `resolveMembershipTarget` in `server/src/services/networks/membership-store.ts`).
 * The card used to fall back to `network.memberships[0]` whenever no row's
 * `stackId` matched this app's own — which, for an adopted app, is EVERY row
 * on a shared network, so it always displayed some OTHER stack's provenance as
 * if it were this app's own. These tests verify the fix: match by
 * `containerName` when the app's own adopted container names are supplied, by
 * `stackId` for a managed service, `memberships[0]` for a stack-owned network,
 * and never borrow an unrelated row.
 */

import { describe, it, expect } from "vitest";
import type { ManagedNetworkView } from "@mini-infra/types";
import { findOwnMembership } from "@/app/applications/[id]/_components/connected-networks-model";

/** A shared "applications" network carrying an unrelated OTHER stack's managed row plus THIS app's adopted (`containerName`-keyed) row. */
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

describe("findOwnMembership (PR #479 review M2)", () => {
  it("matches the adopted app's OWN row by containerName on a shared network", () => {
    const own = findOwnMembership(
      sharedNetworkWithAdoptedAndOtherRow(),
      "stack-mine",
      new Set(["legacy-adopted-container"]),
    );
    expect(own?.id).toBe("membership-mine");
    expect(own?.source).toBe("user");
    expect(own?.createdByName).toBe("Alice");
  });

  it("returns undefined (never borrows an unrelated row) when this app's row can't be identified", () => {
    const own = findOwnMembership(
      sharedNetworkWithAdoptedAndOtherRow(),
      "stack-mine",
      new Set<string>(),
    );
    expect(own).toBeUndefined();
  });

  it("matches a managed service's own row on a shared network via stackId", () => {
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
    const own = findOwnMembership(network, "stack-mine", new Set<string>());
    expect(own?.id).toBe("membership-mine-managed");
    expect(own?.source).toBe("egress");
  });

  it("uses memberships[0] for a stack-owned (private-by-construction) network", () => {
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
    const own = findOwnMembership(network, "stack-mine", new Set<string>());
    expect(own?.id).toBe("membership-own");
    expect(own?.source).toBe("template");
  });
});
