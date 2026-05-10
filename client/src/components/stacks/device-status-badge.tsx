import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type DeviceStatus = "online" | "offline" | "unknown";

interface DeviceStatusBadgeProps {
  status: DeviceStatus;
  lastSeenAt?: string | null;
  size?: "sm" | "md";
}

const dotColor: Record<DeviceStatus, string> = {
  online: "bg-emerald-500",
  offline: "bg-zinc-400",
  unknown: "bg-amber-500",
};

const labelText: Record<DeviceStatus, string> = {
  online: "Online",
  offline: "Offline",
  unknown: "Checking…",
};

/**
 * Compact dot+label indicator for one tailnet device. Mirrors the
 * dot-and-label vocabulary of [connectivity-status.tsx](../../components/connectivity-status.tsx)
 * so the per-row Connect badges read consistently with the global
 * connectivity strip in the header.
 */
export function DeviceStatusBadge({
  status,
  lastSeenAt,
  size = "sm",
}: DeviceStatusBadgeProps) {
  const dotSize = size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3";
  const textSize = size === "sm" ? "text-xs" : "text-sm";

  const lastSeen = formatLastSeen(lastSeenAt);
  const tooltipText =
    status === "unknown"
      ? "Status not reported yet"
      : lastSeen
        ? `Last seen ${lastSeen}`
        : labelText[status];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 transition-colors",
              textSize,
            )}
            aria-label={`Device status: ${labelText[status]}`}
          >
            <span
              className={cn(
                "rounded-full",
                dotSize,
                dotColor[status],
                status === "unknown" && "animate-pulse",
              )}
              aria-hidden="true"
            />
            <span className="text-muted-foreground">{labelText[status]}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function formatLastSeen(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true });
  } catch {
    return null;
  }
}
