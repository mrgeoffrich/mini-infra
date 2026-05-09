import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { IconAlertTriangle } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useStackAddonEndpoints } from "@/hooks/use-stack-addon-endpoints";
import {
  useTailscaleDevices,
  indexDevicesByHostname,
} from "@/hooks/use-tailscale-devices";
import { useServiceConnectivity } from "@/hooks/use-settings-validation";
import { EndpointRow } from "./endpoint-row";
import { AddonBadge } from "@/components/stacks/addon-badge";
import type {
  TailscaleAddonEndpoint,
  TailscaleDeviceStatus,
} from "@mini-infra/types";
import type { DeviceStatus } from "@/components/stacks/device-status-badge";

const VISIBLE_LIMIT = 5;

interface ConnectCardProps {
  stackId: string | undefined;
}

/**
 * Connect card on the Application Overview tab.
 *
 * Renders one compact row per addon-derived tailnet endpoint, grouped by
 * the authored target service. Omits itself entirely when the stack has
 * no addon endpoints — non-Tailscale apps see no Connect surface.
 */
export function ConnectCard({ stackId }: ConnectCardProps) {
  const endpointsQuery = useStackAddonEndpoints(stackId, !!stackId);
  const devicesQuery = useTailscaleDevices();

  const { data: tailscaleConnectivity } = useServiceConnectivity("tailscale");
  const tailscaleStatus = tailscaleConnectivity?.data?.[0]?.status;
  const tailscaleDown =
    tailscaleStatus === "failed" ||
    tailscaleStatus === "timeout" ||
    tailscaleStatus === "unreachable";

  const endpoints = useMemo(
    () => endpointsQuery.data?.endpoints ?? [],
    [endpointsQuery.data?.endpoints],
  );

  // Grouped by target service for the section headers; preserves the
  // server-side ordering within each group.
  const grouped = useMemo(() => groupByTargetService(endpoints), [endpoints]);

  const [expanded, setExpanded] = useState(false);
  const allRows = endpoints.length;
  const visibleGroups = useMemo(() => {
    if (expanded || allRows <= VISIBLE_LIMIT) return grouped;
    return clampGroupedRows(grouped, VISIBLE_LIMIT);
  }, [expanded, allRows, grouped]);

  // Loading state — render the card with skeletons so the operator gets
  // immediate feedback that *something* is loading.
  if (endpointsQuery.isLoading) {
    return (
      <Card data-tour="connect-card">
        <CardHeader>
          <CardTitle>Connect</CardTitle>
          <CardDescription>Reach this application over your tailnet.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // Empty — application has no addon endpoints. Omit the card entirely so
  // non-Tailscale apps' Overview pages stay focused.
  if (allRows === 0) {
    return null;
  }

  // Tailscale connectivity broken — keep the card so the operator sees the
  // empty rows aren't a bug; replace the body with an actionable alert.
  if (tailscaleDown) {
    return (
      <Card data-tour="connect-card">
        <CardHeader>
          <CardTitle>Connect</CardTitle>
          <CardDescription>Reach this application over your tailnet.</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <IconAlertTriangle className="h-4 w-4" />
            <AlertTitle>Tailscale isn&apos;t connected</AlertTitle>
            <AlertDescription>
              Configure it in{" "}
              <Link
                to="/connectivity-tailscale"
                className="underline underline-offset-2 hover:text-destructive-foreground"
              >
                Connectivity settings
              </Link>
              .
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const devicesByHostname = indexDevicesByHostname(devicesQuery.data?.devices);
  const lastUpdatedAt = devicesQuery.data?.lastUpdatedAt ?? null;
  const showStaleFootnote = !lastUpdatedAt && !devicesQuery.isLoading;

  return (
    <Card data-tour="connect-card">
      <CardHeader>
        <CardTitle>Connect</CardTitle>
        <CardDescription>Reach this application over your tailnet.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {visibleGroups.map((group) => (
            <ServiceGroup
              key={group.targetService}
              group={group}
              devicesByHostname={devicesByHostname}
              lastUpdatedAt={lastUpdatedAt}
            />
          ))}

          {!expanded && allRows > VISIBLE_LIMIT && (
            <div className="pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(true)}
              >
                Show all {allRows} endpoints
              </Button>
            </div>
          )}

          {showStaleFootnote && (
            <p className="text-xs text-muted-foreground pt-1">
              Devices have not reported yet — last apply may still be in flight.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ServiceGroup({
  group,
  devicesByHostname,
  lastUpdatedAt,
}: {
  group: { targetService: string; endpoints: TailscaleAddonEndpoint[] };
  devicesByHostname: Map<string, TailscaleDeviceStatus>;
  lastUpdatedAt: string | null;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 pb-1">
        <span className="text-xs font-medium text-muted-foreground">
          {group.targetService}
        </span>
        <AddonBadge addonName="tailscale" />
      </div>
      <ul className="divide-y">
        {group.endpoints.map((endpoint) => {
          const device = devicesByHostname.get(endpoint.hostname);
          const status = resolveStatus(device, lastUpdatedAt);
          return (
            <EndpointRow
              key={`${endpoint.syntheticServiceName}-${endpoint.kind}`}
              endpoint={endpoint}
              status={status}
              lastSeenAt={device?.lastSeen ?? null}
            />
          );
        })}
      </ul>
    </div>
  );
}

function groupByTargetService(
  endpoints: TailscaleAddonEndpoint[],
): Array<{ targetService: string; endpoints: TailscaleAddonEndpoint[] }> {
  const groups = new Map<string, TailscaleAddonEndpoint[]>();
  for (const endpoint of endpoints) {
    const current = groups.get(endpoint.targetService) ?? [];
    current.push(endpoint);
    groups.set(endpoint.targetService, current);
  }
  return Array.from(groups.entries()).map(([targetService, items]) => ({
    targetService,
    endpoints: items,
  }));
}

function clampGroupedRows(
  groups: Array<{ targetService: string; endpoints: TailscaleAddonEndpoint[] }>,
  limit: number,
): typeof groups {
  const out: typeof groups = [];
  let remaining = limit;
  for (const group of groups) {
    if (remaining <= 0) break;
    if (group.endpoints.length <= remaining) {
      out.push(group);
      remaining -= group.endpoints.length;
    } else {
      out.push({
        targetService: group.targetService,
        endpoints: group.endpoints.slice(0, remaining),
      });
      remaining = 0;
    }
  }
  return out;
}

function resolveStatus(
  device: TailscaleDeviceStatus | undefined,
  lastUpdatedAt: string | null,
): DeviceStatus {
  if (!device) {
    // No device record yet — `unknown` until the poller reports.
    return lastUpdatedAt ? "offline" : "unknown";
  }
  return device.online ? "online" : "offline";
}
