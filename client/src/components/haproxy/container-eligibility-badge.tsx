import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IconCircleCheck, IconCircleX } from "@tabler/icons-react";

interface ContainerEligibilityBadgeProps {
  canConnect: boolean;
  reason?: string;
  className?: string;
}

/**
 * Show if container can be connected to HAProxy
 *
 * Displays:
 * - "Can Connect" (green) with IconCircleCheck
 * - "Cannot Connect" (red) with IconCircleX + tooltip with reason
 */
export function ContainerEligibilityBadge({
  canConnect,
  reason,
  className,
}: ContainerEligibilityBadgeProps) {
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
