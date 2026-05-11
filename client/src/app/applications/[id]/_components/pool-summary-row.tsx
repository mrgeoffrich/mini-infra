import { useMemo, useState } from "react";
import {
  IconTerminal2,
  IconWorld,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePoolInstances } from "@/hooks/use-pool-instances";
import type {
  TailscaleAddonEndpoint,
  TailscaleDeviceStatus,
} from "@mini-infra/types";
import { PoolEndpointsSheet } from "./pool-endpoints-sheet";

interface PoolSummaryRowProps {
  endpoint: TailscaleAddonEndpoint;
  stackId: string;
  stackName: string;
  envName: string;
  devicesByHostname: Map<string, TailscaleDeviceStatus>;
  lastUpdatedAt: string | null;
}

/**
 * Single summary row for a pool-target Tailscale endpoint. Renders the
 * addon-kind icon, the template hostname (with `{instance}` rendered as a
 * placeholder), a count badge for active instances, and a "View instances"
 * button that opens the right-side Sheet. Per-instance status badges live
 * inside the Sheet — the card surface itself stays geometry-stable across
 * pool sizes (a 1-instance and a 50-instance pool produce identical rows).
 *
 * The instance count is sourced from the live `usePoolInstances` hook so it
 * stays current with `pool:instance:*` socket events without polling.
 */
export function PoolSummaryRow({
  endpoint,
  stackId,
  stackName,
  envName,
  devicesByHostname,
  lastUpdatedAt,
}: PoolSummaryRowProps) {
  const [open, setOpen] = useState(false);
  const instancesQuery = usePoolInstances(stackId, endpoint.targetService, true);

  const activeCount = useMemo(() => {
    return (
      instancesQuery.data?.filter(
        (i) => i.status === "running" || i.status === "starting",
      ).length ?? 0
    );
  }, [instancesQuery.data]);

  const Icon = endpoint.kind === "ssh" ? IconTerminal2 : IconWorld;

  return (
    <>
      <li
        className="flex items-center gap-3 py-2"
        data-tour={`connect-endpoint-${endpoint.targetService}-${endpoint.kind}-pool`}
      >
        <Icon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          {endpoint.templateHostname ? (
            <code className="font-mono text-sm truncate block text-muted-foreground">
              {endpoint.templateHostname}
            </code>
          ) : (
            <code className="font-mono text-sm truncate block text-muted-foreground">
              {endpoint.hostname}
            </code>
          )}
          <p className="text-xs text-muted-foreground truncate">
            {endpoint.targetService}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0">
          {activeCount} instance{activeCount === 1 ? "" : "s"}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          className="h-7 px-2"
        >
          View
        </Button>
      </li>
      <PoolEndpointsSheet
        open={open}
        onOpenChange={setOpen}
        endpoint={endpoint}
        stackId={stackId}
        stackName={stackName}
        envName={envName}
        devicesByHostname={devicesByHostname}
        lastUpdatedAt={lastUpdatedAt}
      />
    </>
  );
}
