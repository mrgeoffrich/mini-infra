import React from "react";
import { format } from "date-fns";
import { Calendar } from "lucide-react";

interface LastModifiedCellProps {
  lastModified: string;
}

export const LastModifiedCell = React.memo(
  ({ lastModified }: LastModifiedCellProps) => {
    const date = React.useMemo(() => new Date(lastModified), [lastModified]);
    const formattedDate = React.useMemo(
      () => format(date, "MMM d, yyyy"),
      [date],
    );
    const formattedTime = React.useMemo(() => format(date, "HH:mm:ss"), [date]);

    return (
      <div className="text-sm min-h-[2rem] flex flex-col justify-center">
        <div className="flex items-center gap-1">
          <Calendar className="h-3 w-3 text-muted-foreground" />
          <span>{formattedDate}</span>
        </div>
        <div className="text-muted-foreground text-xs">{formattedTime}</div>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.lastModified === nextProps.lastModified,
);

LastModifiedCell.displayName = "LastModifiedCell";
