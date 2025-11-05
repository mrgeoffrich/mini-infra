import React from "react";
import { Badge } from "@/components/ui/badge";
import { PUBLIC_ACCESS_VARIANTS } from "../constants";

interface PublicAccessCellProps {
  publicAccess: "container" | "blob" | null;
}

export const PublicAccessCell = React.memo(
  ({ publicAccess }: PublicAccessCellProps) => {
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
