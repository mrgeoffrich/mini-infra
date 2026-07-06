import type {
  DockerNetwork,
  ManagedNetworkMembershipView,
  ManagedNetworkView,
} from "@mini-infra/types";
import { isUsableLinkNetwork } from "@/hooks/use-networks";

/**
 * The three states a network row on the Connected Networks card can be in,
 * derived from the app's *declared* network set (the primary service's
 * `joinNetworks`) reconciled against the *live* compiled memberships of the
 * running stack. The gap exists because editing `joinNetworks` republishes the
 * template but only attaches to the running containers on the next redeploy.
 *
 *  - `attached`        — live on the running stack (normal read-out).
 *  - `pending-add`     — declared but not yet attached; appears after the user
 *                        adds a network, until a redeploy compiles it.
 *  - `pending-removal` — still attached but removed from the declaration;
 *                        detaches on the next redeploy.
 */
export type NetworkRowState = "attached" | "pending-add" | "pending-removal";

export interface ConnectedNetworkRow {
  /** Stable React key + the Docker network name. */
  name: string;
  state: NetworkRowState;
  /** The live managed-network view — present for attached & pending-removal. */
  network?: ManagedNetworkView;
  /** This app's own membership on `network` (the provenance source of truth). */
  ownMembership?: ManagedNetworkMembershipView;
  /** Existence for a pending-add row (no live view to read it from). */
  pendingExistence?: ManagedNetworkView["existence"];
  /** Whether to render the remove (trash) control on the row. */
  removable: boolean;
}

export interface ConnectedNetworksInput {
  live: ManagedNetworkView[];
  /** The primary service's declared `joinNetworks`. */
  declared: string[];
  /** Network names the app's own stack owns (never user-removable). */
  ownNames: Set<string>;
  stackId: string | undefined;
  /** Adopted-container names this app owns (identify its own row on a shared network). */
  ownContainerNames: Set<string>;
  /** All Docker networks, for pending-add existence + the add picker. */
  rawNetworks: DockerNetwork[];
}

/**
 * This app's own membership on a network — not just any membership, since a
 * shared network (egress, applications, ...) also carries other stacks' rows.
 * A stack-owned network is private by construction (every row is this stack's
 * own); a shared one is matched by the membership's resolved `stackId` or, for
 * an adopted container, by its `containerName`.
 */
export function findOwnMembership(
  network: ManagedNetworkView,
  stackId: string | undefined,
  ownContainerNames: Set<string>,
): ManagedNetworkMembershipView | undefined {
  return network.scope === "stack"
    ? network.memberships[0]
    : network.memberships.find(
        (m) =>
          m.stackId === stackId ||
          (m.containerName != null && ownContainerNames.has(m.containerName)),
      );
}

/**
 * Reconcile the declared network set against the live managed networks into a
 * single ordered row list: live networks first (attached / pending-removal),
 * then declared-but-not-live networks (pending-add).
 */
export function computeConnectedNetworkRows(
  input: ConnectedNetworksInput,
): ConnectedNetworkRow[] {
  const { live, declared, ownNames, stackId, ownContainerNames, rawNetworks } =
    input;

  const declaredSet = new Set(declared);
  const liveNames = new Set(live.map((n) => n.name));
  const rows: ConnectedNetworkRow[] = [];

  for (const network of live) {
    const ownMembership = findOwnMembership(network, stackId, ownContainerNames);
    const isUser = ownMembership?.source === "user";
    // A user-added network that's been dropped from the declaration is on its
    // way out; anything else is a plain attached row.
    const state: NetworkRowState =
      isUser && !declaredSet.has(network.name) ? "pending-removal" : "attached";
    rows.push({
      name: network.name,
      state,
      network,
      ownMembership,
      // Only currently-declared user networks get a remove control.
      removable: state === "attached" && isUser,
    });
  }

  // Declared names not yet live (and not the app's own stack networks) are
  // pending additions the user just made but hasn't redeployed.
  for (const name of declared) {
    if (liveNames.has(name) || ownNames.has(name)) continue;
    const exists = rawNetworks.some((n) => n.name === name);
    rows.push({
      name,
      state: "pending-add",
      pendingExistence: exists ? "present" : "absent",
      removable: true,
    });
  }

  return rows;
}

/**
 * Docker networks the app can be added to: usable link networks it isn't
 * already on — excluding its own stack networks, already-declared networks,
 * and networks already live on the stack.
 */
export function computeAddableNetworks(
  rawNetworks: DockerNetwork[],
  ownNames: Set<string>,
  declared: string[],
  live: ManagedNetworkView[],
): DockerNetwork[] {
  const declaredSet = new Set(declared);
  const liveNames = new Set(live.map((n) => n.name));
  return rawNetworks
    .filter(isUsableLinkNetwork)
    .filter(
      (n) =>
        !ownNames.has(n.name) &&
        !declaredSet.has(n.name) &&
        !liveNames.has(n.name),
    );
}
