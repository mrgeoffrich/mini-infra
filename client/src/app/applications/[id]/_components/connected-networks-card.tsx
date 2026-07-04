import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IconNetwork, IconChevronRight } from "@tabler/icons-react";
import type { ManagedNetworkView } from "@mini-infra/types";
import { useManagedNetworks } from "@/hooks/use-networks";
import { ManagedNetworkDetailSheet } from "@/components/networks/managed-network-detail-sheet";
import {
  MembershipSourceBadge,
  NetworkExistenceBadge,
} from "@/components/networks/managed-network-shared";
import { membershipTargetLabel } from "@/components/networks/managed-network-helpers";

interface ConnectedNetworksCardProps {
  stackId: string | undefined;
}

/**
 * Application detail's "Connected Networks" card — network overhaul Phase
 * 9. Lists every Docker network this application's primary stack owns or
 * has joined (egress, applications, resource networks, its own stack
 * network, ...), each showing the source of the app's own membership on it
 * (template/user/egress/haproxy/system — "why is this app on this
 * network"), with a click-through to the full managed-network detail Sheet.
 * Omits itself entirely when the stack hasn't declared any network
 * membership (shouldn't happen in practice — every service joins its own
 * stack network at minimum — but mirrors `ConnectCard`'s "no data, no card"
 * convention for an undeployed app).
 */
export function ConnectedNetworksCard({ stackId }: ConnectedNetworksCardProps) {
  const { data, isLoading, error } = useManagedNetworks(
    { stackId },
    { enabled: !!stackId },
  );
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  if (!stackId) return null;

  const networks = data ?? [];
  const selectedNetwork = networks.find((n) => n.id === selectedNetworkId) ?? null;

  const openDetail = (network: ManagedNetworkView) => {
    setSelectedNetworkId(network.id);
    setDetailOpen(true);
  };

  if (isLoading) {
    return (
      <Card data-tour="connected-networks-card">
        <CardHeader>
          <CardTitle>Connected Networks</CardTitle>
          <CardDescription>Docker networks this application is attached to.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || networks.length === 0) return null;

  // This app's own membership on each network — not just any membership,
  // since a shared network (egress, applications, ...) also carries other
  // stacks'/services' rows. `useManagedNetworks({ stackId })` already
  // resolved "does this stack own or join this network" server-side
  // (`resolveStackScopedNetworks`); a stack-owned network is private by
  // construction (every row on it is this stack's own), while a shared one
  // is filtered here by the membership's own resolved `stackId`.
  const findOwnMembership = (network: ManagedNetworkView) =>
    (network.scope === "stack"
      ? network.memberships[0]
      : network.memberships.find((m) => m.stackId === stackId)) ?? network.memberships[0];

  return (
    <Card data-tour="connected-networks-card">
      <CardHeader>
        <CardTitle>Connected Networks</CardTitle>
        <CardDescription>Docker networks this application is attached to, and why.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {networks.map((network) => {
            const ownMembership = findOwnMembership(network);
            return (
              <li key={network.id}>
                <button
                  type="button"
                  onClick={() => openDetail(network)}
                  className="w-full flex items-center justify-between gap-3 py-2.5 text-left hover:bg-accent/50 rounded-md px-1.5 -mx-1.5 transition-colors"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <IconNetwork className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{network.name}</div>
                      {ownMembership && (
                        <div className="text-xs text-muted-foreground truncate">
                          {membershipTargetLabel(ownMembership)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {ownMembership && (
                      <MembershipSourceBadge source={ownMembership.source} createdByName={ownMembership.createdByName} />
                    )}
                    <NetworkExistenceBadge existence={network.existence} />
                    <IconChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>

      <ManagedNetworkDetailSheet network={selectedNetwork} open={detailOpen} onOpenChange={setDetailOpen} />
    </Card>
  );
}
