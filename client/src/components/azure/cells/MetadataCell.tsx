import React from "react";
import { Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface MetadataCellProps {
  metadata?: Record<string, string>;
}

export const MetadataCell = React.memo(
  ({ metadata }: MetadataCellProps) => {
    const hasMetadata = metadata && Object.keys(metadata).length > 0;

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        {hasMetadata ? (
          <>
            <Database className="h-4 w-4 text-blue-600" />
            <Badge variant="secondary" className="font-medium">
              {Object.keys(metadata).length} keys
            </Badge>
          </>
        ) : (
          <span className="text-muted-foreground text-sm flex items-center gap-1">
            <Database className="h-4 w-4" />
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
