import {
  IconCircleCheck,
  IconAlertTriangle,
  IconPlugConnected,
  IconPlugConnectedX,
  IconClock,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import type {
  ManagedNetworkMembershipStatus,
  ManagedNetworkView,
  NetworkMembershipSource,
} from "@mini-infra/types";

/**
 * Shared badge/label helpers for the network overhaul Phase 9 visibility
 * UI — used by the networks tab's managed-network view, the environment
 * detail networks panel, and the application detail connected-networks
 * list, so all three read the same provenance/status vocabulary instead of
 * three slightly-different ad hoc renderings.
 */

const DRIFT_STATUS_META: Record<
  ManagedNetworkView["driftStatus"],
  { label: string; icon: typeof IconCircleCheck; badgeClass: string }
> = {
  synced: {
    label: "Synced",
    icon: IconCircleCheck,
    badgeClass: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  },
  drifted: {
    label: "Drifted",
    icon: IconAlertTriangle,
    badgeClass: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  },
};

export function NetworkDriftStatusBadge({
  status,
  driftItemCount,
}: {
  status: ManagedNetworkView["driftStatus"];
  driftItemCount?: number;
}) {
  const meta = DRIFT_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={meta.badgeClass}>
      <Icon className="h-3 w-3 mr-1" />
      {meta.label}
      {status === "drifted" && driftItemCount ? ` (${driftItemCount})` : ""}
    </Badge>
  );
}

const EXISTENCE_META: Record<
  ManagedNetworkView["existence"],
  { label: string; badgeClass: string }
> = {
  present: { label: "Present", badgeClass: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" },
  absent: { label: "Missing", badgeClass: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300" },
  unknown: { label: "Unknown", badgeClass: "bg-muted text-muted-foreground" },
};

export function NetworkExistenceBadge({ existence }: { existence: ManagedNetworkView["existence"] }) {
  const meta = EXISTENCE_META[existence];
  return (
    <Badge variant="outline" className={meta.badgeClass}>
      {meta.label}
    </Badge>
  );
}

const MEMBERSHIP_STATUS_META: Record<
  ManagedNetworkMembershipStatus,
  { label: string; icon: typeof IconPlugConnected; badgeClass: string }
> = {
  connected: {
    label: "Connected",
    icon: IconPlugConnected,
    badgeClass: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  },
  missing: {
    label: "Not attached",
    icon: IconPlugConnectedX,
    badgeClass: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
  },
  "not-deployed": {
    label: "Not deployed",
    icon: IconClock,
    badgeClass: "bg-muted text-muted-foreground",
  },
};

export function MembershipStatusBadge({ status }: { status: ManagedNetworkMembershipStatus }) {
  const meta = MEMBERSHIP_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={meta.badgeClass}>
      <Icon className="h-3 w-3 mr-1" />
      {meta.label}
    </Badge>
  );
}

const SOURCE_META: Record<NetworkMembershipSource, { label: string; badgeClass: string }> = {
  template: { label: "Template", badgeClass: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300" },
  user: { label: "User", badgeClass: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300" },
  egress: { label: "Egress", badgeClass: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300" },
  haproxy: { label: "HAProxy", badgeClass: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300" },
  system: { label: "System", badgeClass: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300" },
};

/**
 * The provenance answer to "why is this container on this network" —
 * `source` badge plus, for `source: 'user'` rows, the acting user's
 * resolved display name (the audit trail the app connect-to-container
 * feature writes).
 */
export function MembershipSourceBadge({
  source,
  createdByName,
}: {
  source: NetworkMembershipSource;
  createdByName?: string;
}) {
  const meta = SOURCE_META[source] ?? { label: source, badgeClass: "bg-muted text-muted-foreground" };
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <Badge variant="outline" className={meta.badgeClass}>
        {meta.label}
      </Badge>
      {source === "user" && createdByName && (
        <span
          className="text-xs text-muted-foreground truncate max-w-[140px]"
          title={createdByName}
        >
          by {createdByName}
        </span>
      )}
    </div>
  );
}
