import { useState } from "react";
import {
  IconLoader2,
  IconRefresh,
  IconNetwork,
  IconAlertTriangle,
} from "@tabler/icons-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ManagedNetworkView } from "@mini-infra/types";
import {
  useReconcileNetworks,
  useSetNetworkEnforceMemberships,
  type NetworkReconcileScopeInput,
} from "@/hooks/use-networks";
import {
  MembershipSourceBadge,
  MembershipStatusBadge,
  NetworkDriftStatusBadge,
  NetworkExistenceBadge,
} from "./managed-network-shared";
import { SCOPE_LABEL, membershipTargetLabel, networkOwnerLabel } from "./managed-network-helpers";

interface ManagedNetworkDetailSheetProps {
  network: ManagedNetworkView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function reconcileScopeFor(network: ManagedNetworkView): NetworkReconcileScopeInput {
  if (network.scope === "stack" && network.stackId) {
    return { scope: "stack", stackId: network.stackId };
  }
  if (network.scope === "environment" && network.environmentId) {
    return { scope: "environment", environmentId: network.environmentId };
  }
  // Host scope has no cheaper scoped reconcile entry point (see
  // services/networks/network-reconciler.ts) — a full sweep is the only way
  // to converge it.
  return { scope: "all" };
}

/**
 * Managed-network detail — owner/purpose/status plus the full
 * desired-vs-actual membership table (source/creator, live attach status),
 * with Reconcile and the per-network enforce-memberships toggle. This is
 * the "why is this container on this network" answer the Phase 9 networks
 * tab exists for.
 */
export function ManagedNetworkDetailSheet({
  network,
  open,
  onOpenChange,
}: ManagedNetworkDetailSheetProps) {
  const reconcile = useReconcileNetworks();
  const setEnforce = useSetNetworkEnforceMemberships();
  const [confirmEnforceOpen, setConfirmEnforceOpen] = useState(false);

  if (!network) return null;

  const handleReconcile = () => {
    reconcile.mutate(reconcileScopeFor(network));
  };

  const handleEnforceChange = (next: boolean) => {
    if (next) {
      // Turning enforcement ON is the direction that can disconnect a live
      // container next sweep — confirm it, mirroring the egress firewall
      // toggle's "confirm the risky direction" pattern.
      setConfirmEnforceOpen(true);
      return;
    }
    setEnforce.mutate({ name: network.name, enforceMemberships: false });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <IconNetwork className="h-5 w-5 text-muted-foreground shrink-0" />
            <span className="truncate">{network.name}</span>
          </SheetTitle>
          <SheetDescription>
            {SCOPE_LABEL[network.scope]} network · owned by {networkOwnerLabel(network)}
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-6">
          {/* Owner / purpose / status */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Owner</div>
              <div className="font-medium">{networkOwnerLabel(network)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Purpose</div>
              <div className="font-medium">{network.purpose}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Status</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <NetworkDriftStatusBadge status={network.driftStatus} driftItemCount={network.driftItemCount} />
                <NetworkExistenceBadge existence={network.existence} />
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Subnet</div>
              <div className="font-mono text-xs mt-1">{network.subnet ?? "—"}</div>
            </div>
          </div>

          <Separator />

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReconcile}
              disabled={reconcile.isPending}
              data-tour="managed-network-reconcile-button"
            >
              {reconcile.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconRefresh className="h-4 w-4 mr-2" />
              )}
              Reconcile
            </Button>

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={network.enforceMemberships}
                      onCheckedChange={handleEnforceChange}
                      disabled={setEnforce.isPending}
                      data-tour="managed-network-enforce-toggle"
                      aria-label={`Enforce memberships for ${network.name}`}
                    />
                    <span className="text-sm">Enforce memberships</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  When on, the reconciler disconnects containers attached to
                  this network with no matching desired-state row. Off by
                  default (connect-only).
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <Separator />

          {/* Membership table */}
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-2">
              Members ({network.memberships.length})
            </h4>
            {network.memberships.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No desired-state memberships recorded for this network.
              </p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Target</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {network.memberships.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="max-w-[160px]">
                          <div className="truncate font-medium text-sm" title={membershipTargetLabel(m)}>
                            {membershipTargetLabel(m)}
                          </div>
                          {m.aliases && m.aliases.length > 0 && (
                            <div className="text-xs text-muted-foreground font-mono truncate">
                              alias: {m.aliases.join(", ")}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <MembershipSourceBadge source={m.source} createdByName={m.createdByName} />
                        </TableCell>
                        <TableCell>
                          <MembershipStatusBadge status={m.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Unattributed containers */}
          {network.unattributedContainers.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                <IconAlertTriangle className="h-4 w-4 text-amber-500" />
                Unattributed attachments ({network.unattributedContainers.length})
              </h4>
              <p className="text-xs text-muted-foreground mb-2">
                Live container(s) attached to this network with no matching desired-state row.
              </p>
              <ul className="space-y-1">
                {network.unattributedContainers.map((c) => (
                  <li key={c.id} className="text-sm font-mono">
                    <Badge variant="outline" className="mr-2">
                      unattributed
                    </Badge>
                    {c.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SheetContent>

      <AlertDialog open={confirmEnforceOpen} onOpenChange={setConfirmEnforceOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable membership enforcement?</AlertDialogTitle>
            <AlertDialogDescription>
              The reconciler will start disconnecting any container attached
              to &quot;{network.name}&quot; that has no matching desired-state
              membership row, on its next sweep. This can drop a container's
              network access if its attachment was never recorded as desired
              state.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setEnforce.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmEnforceOpen(false);
                setEnforce.mutate({ name: network.name, enforceMemberships: true });
              }}
              disabled={setEnforce.isPending}
            >
              Enable enforcement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
