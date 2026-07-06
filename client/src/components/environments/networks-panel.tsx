import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { IconNetwork, IconChevronRight } from "@tabler/icons-react";
import type { ManagedNetworkView } from "@mini-infra/types";
import { useManagedNetworks } from "@/hooks/use-networks";
import { ManagedNetworkDetailSheet } from "@/components/networks/managed-network-detail-sheet";
import {
  NetworkDriftStatusBadge,
  NetworkExistenceBadge,
} from "@/components/networks/managed-network-shared";

interface EnvironmentNetworksPanelProps {
  environmentId: string;
  className?: string;
}

/**
 * Environment detail's networks panel — network overhaul Phase 9.
 * Generalises the previous single-purpose `EgressNetworkCard` (egress only)
 * into a panel covering every environment-scoped `ManagedNetwork` (egress,
 * applications, and any other per-environment resource network), each row
 * showing status/subnet/member count with a click-through to the same
 * `ManagedNetworkDetailSheet` the networks tab uses — one detail view, not
 * two slightly-different ones.
 */
export function EnvironmentNetworksPanel({ environmentId, className }: EnvironmentNetworksPanelProps) {
  const { data, isLoading, error } = useManagedNetworks({ scope: "environment", environmentId });
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const networks = useMemo(() => data ?? [], [data]);
  const selectedNetwork = useMemo(
    () => networks.find((n) => n.id === selectedNetworkId) ?? null,
    [networks, selectedNetworkId],
  );

  const openDetail = (network: ManagedNetworkView) => {
    setSelectedNetworkId(network.id);
    setDetailOpen(true);
  };

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium">Networks</CardTitle>
          <CardDescription className="text-xs">
            Docker networks this environment owns — egress, applications, and any other resource networks
          </CardDescription>
        </div>
        <IconNetwork className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load networks: {error.message}</p>
        ) : networks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No managed networks recorded for this environment yet.
          </p>
        ) : (
          <ul className="divide-y">
            {networks.map((network, index) => (
              <li key={network.id}>
                <button
                  type="button"
                  onClick={() => openDetail(network)}
                  className="w-full flex items-center justify-between gap-3 py-2.5 text-left hover:bg-accent/50 rounded-md px-1.5 -mx-1.5 transition-colors"
                  data-tour={index === 0 ? "environment-networks-panel-row" : undefined}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{network.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {network.purpose} · {network.memberships.length} member
                      {network.memberships.length !== 1 ? "s" : ""}
                      {network.subnet && <span className="font-mono"> · {network.subnet}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <NetworkExistenceBadge existence={network.existence} />
                    <NetworkDriftStatusBadge status={network.driftStatus} driftItemCount={network.driftItemCount} />
                    <IconChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </button>
                {index < networks.length - 1 && <Separator className="mt-0" />}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ManagedNetworkDetailSheet network={selectedNetwork} open={detailOpen} onOpenChange={setDetailOpen} />
    </Card>
  );
}
