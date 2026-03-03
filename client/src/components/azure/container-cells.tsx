import React from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { IconBrandDocker, IconCalendar } from "@tabler/icons-react";

const CopyButton = React.memo(
  ({
    text,
    className = "h-6 w-6 p-0",
  }: {
    text: string;
    className?: string;
  }) => {
    const handleCopy = React.useCallback(async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error("Failed to copy text: ", err);
      }
    }, [text]);

    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className={className}
        title={`Copy ${text}`}
      >
        <span className="sr-only">Copy {text}</span>
      </Button>
    );
  },
  (prevProps, nextProps) =>
    prevProps.text === nextProps.text &&
    prevProps.className === nextProps.className,
);

CopyButton.displayName = "CopyButton";

export const ContainerNameCell = React.memo(
  ({ name }: { name: string }) => (
    <div className="flex items-center gap-2 min-h-[2rem]">
      <IconBrandDocker className="h-4 w-4 text-blue-600 shrink-0" />
      <span className="font-medium truncate flex-1">{name}</span>
      <CopyButton text={name} />
    </div>
  ),
  (prevProps, nextProps) => prevProps.name === nextProps.name,
);

ContainerNameCell.displayName = "ContainerNameCell";

export const LastModifiedCell = React.memo(
  ({ lastModified }: { lastModified: string }) => {
    const date = React.useMemo(() => new Date(lastModified), [lastModified]);
    const formattedDate = React.useMemo(
      () => format(date, "MMM d, yyyy"),
      [date],
    );
    const formattedTime = React.useMemo(() => format(date, "HH:mm:ss"), [date]);

    return (
      <div className="text-sm min-h-[2rem] flex flex-col justify-center">
        <div className="flex items-center gap-1">
          <IconCalendar className="h-3 w-3 text-muted-foreground" />
          <span>{formattedDate}</span>
        </div>
        <div className="text-muted-foreground text-xs">{formattedTime}</div>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.lastModified === nextProps.lastModified,
);

LastModifiedCell.displayName = "LastModifiedCell";
