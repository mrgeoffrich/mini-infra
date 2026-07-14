import { useState } from "react";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowUp,
  IconHistory,
  IconLoader2,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getStackAttention } from "@/lib/stack-attention";
import { useStackUpgradeFlow } from "@/hooks/use-stack-upgrade-flow";
import { UpgradeRotateGate } from "@/components/stacks/UpgradeRotateGate";
import { ChangeVersionDialog } from "@/components/stacks/ChangeVersionDialog";
import type { StackAttentionLevel, StackInfo } from "@mini-infra/types";

/**
 * "Update available" badge shown when a stack's template has a newer published
 * version than the one the stack is running (`templateUpdateAvailable`).
 */
export function UpdateAvailableBadge({ className }: { className?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "cursor-help border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
              className,
            )}
            data-tour="stack-update-available-badge"
          >
            <IconArrowUp className="mr-1 h-3 w-3" />
            Update available
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          A newer version of this stack&apos;s template has been published. Upgrade
          &amp; deploy to adopt it.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Shown when a stack sits on a template version NEWER than the template's
 * current one — which is what a template rollback leaves behind, since rollback
 * re-points `currentVersionId` without touching installed stacks.
 *
 * This state used to be invisible: `templateUpdateAvailable` is false (there is
 * no newer version to adopt), so the stack rendered as though it were perfectly
 * up to date while actually running a version the template owner had retracted.
 * Say so, and point at the way out.
 */
export function StrandedAheadBadge({
  stack,
  className,
}: {
  stack: StackInfo;
  className?: string;
}) {
  if (stack.templateVersionRelation !== "ahead") return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "cursor-help border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
              className,
            )}
            data-tour="stack-ahead-of-current-badge"
          >
            <IconHistory className="mr-1 h-3 w-3" />
            Ahead of current
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          This stack runs template v{stack.templateVersion}, but the template&apos;s
          current version is v{stack.templateCurrentVersion} — the template was
          rolled back after this stack adopted v{stack.templateVersion}. Use Change
          version to move it.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Presentation per attention level. A stack whose service has crashed is an
 * outage and must not look like "a newer template version exists" — before the
 * server-computed levels existed, every reason rendered in the same amber and
 * the badge could not tell the two apart.
 */
const ATTENTION_STYLES: Partial<
  Record<StackAttentionLevel, { className: string; icon: typeof IconAlertTriangle }>
> = {
  critical: {
    className:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
    icon: IconAlertCircle,
  },
  warning: {
    className:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
    icon: IconAlertTriangle,
  },
};

/**
 * Single "needs attention" indicator rolling up live runtime issues, drift,
 * NATS drift and error status into one affordance with the reasons listed.
 * Severity comes from the server-computed level.
 *
 * Renders nothing when the stack is healthy, and nothing at `info` either: an
 * available template upgrade is an opportunity, not something wrong, and every
 * surface that renders this badge already renders the dedicated
 * {@link UpdateAvailableBadge} beside it. Showing both said "Update available"
 * twice in the same row.
 */
export function NeedsAttentionBadge({
  stack,
  className,
}: {
  stack: StackInfo;
  className?: string;
}) {
  const attention = getStackAttention(stack);
  const style = ATTENTION_STYLES[attention.level];
  if (!attention.needsAttention || !style) return null;

  const Icon = style.icon;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn("cursor-help", style.className, className)}
            data-tour="stack-needs-attention-badge"
          >
            <Icon className="mr-1 h-3 w-3" />
            Needs attention
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {attention.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * "Upgrade & deploy" button — chains POST /upgrade then the tracked apply as a
 * single user action. Used on the application card/header, infra stack rows,
 * the plan view, and the stack detail page so the affordance is identical
 * everywhere.
 */
export function UpgradeButton({
  stackId,
  label,
  size = "sm",
  variant = "default",
  disabled,
  className,
  children,
}: {
  stackId: string;
  /** Task-tracker label, e.g. `Upgrading ${app.name}`. */
  label: string;
  size?: "sm" | "default" | "lg" | "icon";
  variant?: "default" | "outline" | "secondary" | "ghost";
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const flow = useStackUpgradeFlow({ stackId, label });

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={className}
        disabled={disabled || flow.busy}
        onClick={() => void flow.start()}
        data-tour="stack-upgrade-button"
      >
        {flow.busy ? (
          <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <IconArrowUp className="mr-1 h-4 w-4" />
        )}
        {children ?? "Upgrade & deploy"}
      </Button>
      <UpgradeRotateGate flow={flow} />
    </>
  );
}

/**
 * "Change version" — opens the picker so a stack can be moved to any published
 * template version, including an older one.
 *
 * Distinct from {@link UpgradeButton}, which always targets the current version:
 * this is the affordance for a deliberate choice (downgrade after a bad release,
 * or recovering a stack stranded ahead of current by a template rollback).
 * Renders nothing for templateless stacks — there are no versions to choose.
 */
export function ChangeVersionButton({
  stack,
  label,
  size = "sm",
  variant = "outline",
  disabled,
  className,
}: {
  stack: StackInfo;
  label: string;
  size?: "sm" | "default" | "lg" | "icon";
  variant?: "default" | "outline" | "secondary" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!stack.templateId) return null;

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={className}
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-tour="stack-change-version-button"
      >
        <IconHistory className="mr-1 h-4 w-4" />
        Change version
      </Button>
      <ChangeVersionDialog
        stack={stack}
        label={label}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
