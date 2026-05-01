import React from "react";
import { Badge } from "@/components/ui/badge";
import {
  IconLock,
  IconLockOpen,
  IconWorld,
  IconShield,
  IconDatabase,
} from "@tabler/icons-react";

const LEASE_STATUS_VARIANTS = {
  locked: {
    variant: "destructive" as const,
    icon: IconLock,
    color: "text-red-600",
    label: "Locked",
  },
  unlocked: {
    variant: "default" as const,
    icon: IconLockOpen,
    color: "text-green-600",
    label: "Unlocked",
  },
} as const;

const PUBLIC_ACCESS_VARIANTS = {
  container: {
    variant: "secondary" as const,
    icon: IconWorld,
    color: "text-blue-600",
    label: "Container",
  },
  blob: {
    variant: "outline" as const,
    icon: IconWorld,
    color: "text-amber-600",
    label: "Blob",
  },
  null: {
    variant: "outline" as const,
    icon: IconShield,
    color: "text-gray-600",
    label: "Private",
  },
} as const;

export const LeaseStatusCell = React.memo(
  ({ leaseStatus }: { leaseStatus: "locked" | "unlocked" }) => {
    const statusConfig = LEASE_STATUS_VARIANTS[leaseStatus];
    const StatusIcon = statusConfig.icon;

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        <StatusIcon className={`h-4 w-4 ${statusConfig.color}`} />
        <Badge variant={statusConfig.variant} className="font-medium">
          {statusConfig.label}
        </Badge>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.leaseStatus === nextProps.leaseStatus,
);

LeaseStatusCell.displayName = "LeaseStatusCell";

export const PublicAccessCell = React.memo(
  ({ publicAccess }: { publicAccess: "container" | "blob" | null }) => {
    const accessConfig = PUBLIC_ACCESS_VARIANTS[publicAccess || "null"];
    const AccessIcon = accessConfig.icon;

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        <AccessIcon className={`h-4 w-4 ${accessConfig.color}`} />
        <Badge variant={accessConfig.variant} className="font-medium">
          {accessConfig.label}
        </Badge>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.publicAccess === nextProps.publicAccess,
);

PublicAccessCell.displayName = "PublicAccessCell";

export const MetadataCell = React.memo(
  ({ metadata }: { metadata?: Record<string, string> }) => {
    const hasMetadata = metadata && Object.keys(metadata).length > 0;

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        {hasMetadata ? (
          <>
            <IconDatabase className="h-4 w-4 text-blue-600" />
            <Badge variant="secondary" className="font-medium">
              {Object.keys(metadata).length} keys
            </Badge>
          </>
        ) : (
          <span className="text-muted-foreground text-sm flex items-center gap-1">
            <IconDatabase className="h-4 w-4" />
            None
          </span>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    const prevKeys = prevProps.metadata
      ? Object.keys(prevProps.metadata).length
      : 0;
    const nextKeys = nextProps.metadata
      ? Object.keys(nextProps.metadata).length
      : 0;
    return prevKeys === nextKeys;
  },
);

MetadataCell.displayName = "MetadataCell";
