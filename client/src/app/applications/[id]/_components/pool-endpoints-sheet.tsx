import { useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconLoader2,
  IconSearch,
} from "@tabler/icons-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { usePoolInstances } from "@/hooks/use-pool-instances";
import {
  buildPoolInstanceHostname,
  type PoolInstanceInfo,
  type TailscaleAddonEndpoint,
  type TailscaleDeviceStatus,
} from "@mini-infra/types";
import { PoolInstanceRow } from "./pool-instance-row";
import type { DeviceStatus } from "@/components/stacks/device-status-badge";

interface PoolEndpointsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pool-summary endpoint that opened the Sheet. */
  endpoint: TailscaleAddonEndpoint;
  stackId: string;
  /** Stack name + env-slug — needed to recompute per-instance hostnames
   * client-side via `buildPoolInstanceHostname`. The server-derived
   * `poolHostnamePrefix` carries this triple already; passing the parts
   * separately would force the Sheet to re-sanitise. */
  stackName: string;
  envName: string;
  devicesByHostname: Map<string, TailscaleDeviceStatus>;
  lastUpdatedAt: string | null;
}

/**
 * Right-side Sheet listing per-instance Tailscale endpoints for a pool
 * target. Driven by the live `usePoolInstances` pipeline so the list
 * invalidates on `pool:instance:*` socket events while open — operators
 * see new instances and reaps land in real time without refreshing.
 *
 * The summary card itself is read-only; this Sheet is the only surface
 * where per-instance URLs render with their device-status badges.
 */
export function PoolEndpointsSheet({
  open,
  onOpenChange,
  endpoint,
  stackId,
  stackName,
  envName,
  devicesByHostname,
  lastUpdatedAt,
}: PoolEndpointsSheetProps) {
  const instancesQuery = usePoolInstances(stackId, endpoint.targetService, open);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const all: PoolInstanceInfo[] = instancesQuery.data ?? [];
    const matchesSearch = (instance: PoolInstanceInfo) => {
      if (!search) return true;
      return instance.instanceId.toLowerCase().includes(search.toLowerCase());
    };
    const active = all.filter(
      (i) =>
        (i.status === "running" || i.status === "starting") &&
        matchesSearch(i),
    );
    // Sort: running (online-first by device status) → starting, then
    // alphabetical by instanceId.
    return active.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "running" ? -1 : 1;
      }
      return a.instanceId.localeCompare(b.instanceId);
    });
  }, [instancesQuery.data, search]);

  const kindLabel = endpoint.kind === "ssh" ? "SSH" : "HTTPS";
  const targetLabel = `${endpoint.targetService} · ${kindLabel}`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Pool instances · {targetLabel}</SheetTitle>
          <SheetDescription>
            {endpoint.templateHostname ? (
              <code className="font-mono text-xs break-all">
                {endpoint.templateHostname}
              </code>
            ) : (
              <span>Tailnet domain not yet resolved.</span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-4 space-y-3">
          <div className="relative">
            <IconSearch
              className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              placeholder="Filter instances…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>

          {instancesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconLoader2 className="size-4 animate-spin" />
              Loading instances…
            </div>
          ) : instancesQuery.isError ? (
            <Alert variant="destructive">
              <IconAlertTriangle className="size-4" />
              <AlertTitle>Couldn&apos;t load pool instances</AlertTitle>
              <AlertDescription>
                {instancesQuery.error instanceof Error
                  ? instancesQuery.error.message
                  : "Retry by closing and reopening this panel."}
              </AlertDescription>
            </Alert>
          ) : filtered.length === 0 ? (
            <EmptyState hasSearch={!!search} />
          ) : (
            <ul className="divide-y">
              {filtered.map((instance) => {
                const hostname = buildPoolInstanceHostname(
                  stackName,
                  endpoint.targetService,
                  envName.length > 0 ? envName : "host",
                  instance.instanceId,
                );
                const url = resolvePerInstanceUrl(endpoint, hostname);
                const status = resolveStatus(
                  devicesByHostname.get(hostname),
                  lastUpdatedAt,
                );
                return (
                  <PoolInstanceRow
                    key={instance.id}
                    instanceId={instance.instanceId}
                    kind={endpoint.kind}
                    hostname={hostname}
                    url={url}
                    status={status}
                    lastSeenAt={devicesByHostname.get(hostname)?.lastSeen ?? null}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  if (hasSearch) {
    return (
      <p className="text-sm text-muted-foreground">No instances match.</p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      No active instances. Pool instances are created on demand by the caller
      service.
    </p>
  );
}

function resolvePerInstanceUrl(
  endpoint: TailscaleAddonEndpoint,
  hostname: string,
): string | null {
  if (!endpoint.tailnet) return null;
  const fqdn = `${hostname}.${endpoint.tailnet}`;
  if (endpoint.kind === "ssh") return `ssh root@${fqdn}`;
  return `https://${fqdn}`;
}

function resolveStatus(
  device: TailscaleDeviceStatus | undefined,
  lastUpdatedAt: string | null,
): DeviceStatus {
  if (!device) return lastUpdatedAt ? "offline" : "unknown";
  return device.online ? "online" : "offline";
}
