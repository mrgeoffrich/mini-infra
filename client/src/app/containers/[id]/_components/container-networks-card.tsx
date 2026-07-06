import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { IconNetwork, IconPlus, IconTrash } from "@tabler/icons-react";
import type { DockerNetwork } from "@mini-infra/types";
import {
  useNetworks,
  useConnectContainerNetwork,
  useDisconnectContainerNetwork,
} from "@/hooks/use-networks";

interface ContainerNetworksCardProps {
  containerId: string;
  containerName: string;
  /** Called after a successful attach/detach so the parent can refresh the
   *  container detail (e.g. the primary IP-address row). */
  onMutated?: () => void;
}

/**
 * Networks a container may be attached to via `docker network connect`.
 * Excludes only the `host`/`none` pseudo-networks (you can't `connect` to
 * those). Unlike the application "Connected Networks" picker
 * (`isUsableLinkNetwork`), the default `bridge` IS offered here — this is a
 * raw, imperative attach, not a DNS-linking join.
 */
function isAttachableNetwork(net: DockerNetwork): boolean {
  if (net.driver === "host" || net.driver === "null") return false;
  if (net.name === "host" || net.name === "none") return false;
  return true;
}

/**
 * Container detail's "Networks" card. Lists every Docker network this
 * container is currently attached to (with its IP on each) and lets the
 * operator attach/detach networks with immediate, imperative semantics —
 * exactly `docker network connect` / `docker network disconnect`. Detach is
 * guarded by a confirm dialog since it can disrupt a running container.
 *
 * The connected + addable lists are both derived from the single
 * `useNetworks()` query (matching this container by name against each
 * network's attached-container list), so no per-container read endpoint is
 * needed.
 */
export function ContainerNetworksCard({
  containerId,
  containerName,
  onMutated,
}: ContainerNetworksCardProps) {
  const { data, isLoading, error } = useNetworks();
  const [pendingPick, setPendingPick] = useState("");
  const [networkToRemove, setNetworkToRemove] = useState<DockerNetwork | null>(null);

  const connectMutation = useConnectContainerNetwork({
    onSuccess: () => onMutated?.(),
  });
  const disconnectMutation = useDisconnectContainerNetwork({
    onSuccess: () => {
      setNetworkToRemove(null);
      onMutated?.();
    },
  });

  const networks = useMemo(() => data?.networks ?? [], [data]);

  const connected = useMemo(
    () =>
      networks
        .filter((n) => n.containers.some((c) => c.name === containerName))
        .map((n) => ({
          network: n,
          ip: n.containers.find((c) => c.name === containerName)?.ipv4Address ?? "",
        }))
        .sort((a, b) => a.network.name.localeCompare(b.network.name)),
    [networks, containerName],
  );

  const addable = useMemo(() => {
    const connectedIds = new Set(connected.map((r) => r.network.id));
    return networks
      .filter((n) => isAttachableNetwork(n) && !connectedIds.has(n.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [networks, connected]);

  const isMutating = connectMutation.isPending || disconnectMutation.isPending;

  const handleAdd = () => {
    if (!pendingPick) return;
    connectMutation.mutate({ networkId: pendingPick, containerId });
    setPendingPick("");
  };

  return (
    <Card data-tour="container-networks-card">
      <CardHeader>
        <CardTitle>Networks</CardTitle>
        <CardDescription>
          Docker networks this container is attached to. Add or remove networks
          below — changes take effect immediately (equivalent to{" "}
          <code className="text-xs">docker network connect</code> /{" "}
          <code className="text-xs">disconnect</code>).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            Failed to load networks: {error instanceof Error ? error.message : "unknown error"}
          </p>
        ) : (
          <>
            {connected.length > 0 ? (
              <ul className="divide-y">
                {connected.map(({ network, ip }) => (
                  <li key={network.id} className="flex items-center gap-1">
                    <div className="flex-1 min-w-0 flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0 flex items-center gap-2">
                        <IconNetwork className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate">{network.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {ip ? `IP: ${ip}` : "Attached"}
                          </div>
                        </div>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {network.driver}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => setNetworkToRemove(network)}
                      disabled={isMutating}
                      aria-label={`Disconnect network ${network.name}`}
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                This container isn't attached to any networks.
              </p>
            )}

            {/* Attach a network (imperative docker network connect) */}
            <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center">
              <Select
                value={pendingPick}
                onValueChange={setPendingPick}
                disabled={addable.length === 0 || isMutating}
              >
                <SelectTrigger className="w-full sm:flex-1">
                  <SelectValue
                    placeholder={
                      addable.length === 0
                        ? "No networks available to attach"
                        : "Select a network to attach"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((net) => (
                    <SelectItem key={net.id} value={net.id}>
                      {net.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAdd}
                disabled={!pendingPick || isMutating}
                className="shrink-0"
              >
                <IconPlus className="mr-1 h-4 w-4" />
                Attach network
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog
        open={!!networkToRemove}
        onOpenChange={(open) => !open && setNetworkToRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect network</AlertDialogTitle>
            <AlertDialogDescription>
              Disconnect this container from the network "{networkToRemove?.name}"?
              If the container is running this may interrupt its connectivity on
              that network. You can re-attach it afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (networkToRemove) {
                  disconnectMutation.mutate({
                    networkId: networkToRemove.id,
                    containerId,
                  });
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
