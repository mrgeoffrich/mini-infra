import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IconCircleCheck, IconCircleX, IconNetwork } from "@tabler/icons-react";

interface ContainerEligibilityBadgeProps {
  canConnect: boolean;
  needsNetworkJoin?: boolean;
  reason?: string;
  className?: string;
}

/**
 * Show if container can be connected to HAProxy
 *
 * Displays:
 * - "Can Connect" (green) with IconCircleCheck
 * - "Needs Network Join" (amber) with IconNetwork + tooltip with reason
 * - "Cannot Connect" (red) with IconCircleX + tooltip with reason
 */
export function ContainerEligibilityBadge({
  canConnect,
  needsNetworkJoin,
  reason,
  className,
}: ContainerEligibilityBadgeProps) {
  if (canConnect && needsNetworkJoin) {
    const badge = (
      <Badge
        variant="outline"
        className={`text-amber-700 border-amber-200 bg-amber-50 dark:text-amber-300 dark:border-amber-800 dark:bg-amber-950 ${className || ""}`}
      >
        <IconNetwork className="w-3 h-3 mr-1" />
        Needs Network Join
      </Badge>
    );

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent>
            <p className="text-sm">{reason}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const badge = canConnect ? (
    <Badge
      variant="outline"
      className={`text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950 ${className || ""}`}
    >
      <IconCircleCheck className="w-3 h-3 mr-1" />
      Can Connect
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className={`text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950 ${className || ""}`}
    >
      <IconCircleX className="w-3 h-3 mr-1" />
      Cannot Connect
    </Badge>
  );

  // If can connect or no reason provided, just show badge
  if (canConnect || !reason) {
    return badge;
  }

  // Otherwise, wrap in tooltip with reason
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent>
          <p className="text-sm">{reason}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
