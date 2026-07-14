import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { StackStatus } from "@mini-infra/types";
import { cn } from "@/lib/utils";

interface StatusMeta {
  className: string;
  label: string;
  /** What the status means + the next action, shown in a tooltip. */
  tooltip: string;
}

/**
 * Colour, label, and explanatory tooltip for every stack status. Single source
 * of truth so the host templates list, the environment stacks list, the global
 * stacks page, the stack detail page, the application header, and the Network
 * Access page all render a stack's status identically — and every status is
 * explained with its next action.
 */
const STACK_STATUS_BADGE: Record<StackStatus, StatusMeta> = {
  synced: {
    className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
    label: "Synced",
    tooltip: "Running the last applied definition with no pending changes.",
  },
  drifted: {
    className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
    label: "Drifted",
    tooltip: "Live containers differ from the definition — run Apply to reconcile them.",
  },
  pending: {
    className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
    label: "Pending",
    tooltip: "The definition changed but hasn't been applied — run Apply to deploy it.",
  },
  error: {
    className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    label: "Error",
    tooltip: "The last apply failed — check the failure reason and retry Apply.",
  },
  undeployed: {
    className: "",
    label: "Undeployed",
    tooltip: "Not deployed — its containers don't exist yet. Deploy or Apply to create them.",
  },
};

interface StackStatusBadgeProps {
  /** Stack status; unknown values fall back to the "undeployed" styling. */
  status: StackStatus | string;
  className?: string;
  /**
   * Per-status label overrides (e.g. friendly "Running" for synced on the
   * application header). Colour + tooltip stay; only the displayed text
   * changes. Statuses not present here keep their canonical label — so all
   * statuses are still covered.
   */
  labelOverrides?: Partial<Record<StackStatus, string>>;
  /** Set false to render a bare pill with no explanatory tooltip. */
  showTooltip?: boolean;
}

/**
 * Renders a stack's status as a coloured pill with an explanatory tooltip.
 * `undeployed` uses the muted `secondary` variant; every other status uses
 * `outline` + a status colour.
 */
export function StackStatusBadge({
  status,
  className,
  labelOverrides,
  showTooltip = true,
}: StackStatusBadgeProps) {
  const key = (STACK_STATUS_BADGE[status as StackStatus]
    ? (status as StackStatus)
    : "undeployed") as StackStatus;
  const variant = STACK_STATUS_BADGE[key];
  const label = labelOverrides?.[key] ?? variant.label;

  const badge = (
    <Badge
      variant={key === "undeployed" ? "secondary" : "outline"}
      className={cn(variant.className, className)}
    >
      {label}
    </Badge>
  );

  if (!showTooltip) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help">{badge}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{variant.tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
