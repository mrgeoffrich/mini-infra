import { Badge } from "@/components/ui/badge";
import type { StackStatus } from "@mini-infra/types";
import { cn } from "@/lib/utils";

/**
 * Colour + label for every stack status. Single source of truth so the host
 * templates list, the environment stacks list, and the Network Access page
 * all render a stack's status identically.
 */
const STACK_STATUS_BADGE: Record<StackStatus, { className: string; label: string }> = {
  synced: {
    className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
    label: "Synced",
  },
  drifted: {
    className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
    label: "Drifted",
  },
  pending: {
    className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
    label: "Pending",
  },
  error: {
    className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    label: "Error",
  },
  undeployed: {
    className: "",
    label: "Undeployed",
  },
  removed: {
    className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
    label: "Removed",
  },
};

interface StackStatusBadgeProps {
  /** Stack status; unknown values fall back to the "undeployed" styling. */
  status: StackStatus | string;
  className?: string;
}

/**
 * Renders a stack's status as a coloured pill. `undeployed` uses the muted
 * `secondary` variant; every other status uses `outline` + a status colour.
 */
export function StackStatusBadge({ status, className }: StackStatusBadgeProps) {
  const variant = STACK_STATUS_BADGE[status as StackStatus] ?? STACK_STATUS_BADGE.undeployed;
  return (
    <Badge
      variant={status === "undeployed" ? "secondary" : "outline"}
      className={cn(variant.className, className)}
    >
      {variant.label}
    </Badge>
  );
}
