import React from "react";
import { Badge } from "@/components/ui/badge";
import { LEASE_STATUS_VARIANTS } from "../constants";

interface LeaseStatusCellProps {
  leaseStatus: "locked" | "unlocked";
}

export const LeaseStatusCell = React.memo(
  ({ leaseStatus }: LeaseStatusCellProps) => {
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
