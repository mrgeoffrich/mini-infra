import React from "react";
import {
  IconNetworkOff,
  IconPlugConnected,
  IconPlugConnectedX,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import type { NetworkDriftItem } from "@mini-infra/types";

interface NetworkDriftRowProps {
  item: NetworkDriftItem;
}

/**
 * Renders one network overhaul Phase 7 drift item — mirrors
 * `ServiceActionRow`'s icon/badge conventions (colour = severity) so network
 * drift reads as part of the same plan, not a bolted-on afterthought. No
 * design pass yet (Phase 7 is explicitly "[no design]"; the full networks
 * visibility UI is Phase 9) — this is deliberately minimal.
 */
const driftConfig = {
  "network-missing": {
    icon: IconNetworkOff,
    label: "Network Missing",
    badgeClass: "bg-red-500 text-white hover:bg-red-600",
    iconClass: "text-red-500",
  },
  "membership-missing": {
    icon: IconPlugConnected,
    label: "Not Attached",
    badgeClass: "bg-orange-500 text-white hover:bg-orange-600",
    iconClass: "text-orange-500",
  },
  "membership-stale": {
    icon: IconPlugConnectedX,
    label: "Stale Attachment",
    badgeClass: "bg-amber-500 text-white hover:bg-amber-600",
    iconClass: "text-amber-500",
  },
  "spec-mismatch": {
    icon: IconAlertTriangle,
    label: "Spec Mismatch",
    badgeClass: "bg-orange-500 text-white hover:bg-orange-600",
    iconClass: "text-orange-500",
  },
} as const;

export const NetworkDriftRow = React.memo(function NetworkDriftRow({
  item,
}: NetworkDriftRowProps) {
  const config = driftConfig[item.type];
  const Icon = config.icon;

  const subject =
    item.target?.serviceName ??
    item.target?.containerName ??
    (item.containers && item.containers.length > 0
      ? item.containers.map((c) => c.name).join(", ")
      : undefined);

  return (
    <div className="flex items-start gap-3 py-3">
      <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${config.iconClass}`} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium truncate">{item.networkName}</span>
            {subject && (
              <span className="text-xs text-muted-foreground truncate">
                {subject}
              </span>
            )}
          </div>
          <Badge className={config.badgeClass}>{config.label}</Badge>
        </div>

        <p className="text-sm text-muted-foreground mt-1">{item.message}</p>
      </div>
    </div>
  );
});
