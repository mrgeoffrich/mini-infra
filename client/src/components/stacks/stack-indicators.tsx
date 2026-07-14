import { useState } from "react";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowUp,
  IconArrowUpCircle,
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
import { useUpgradeAndApplyStack, fetchStackUpgradeInputs } from "@/hooks/use-stacks";
import { getStackAttention } from "@/lib/stack-attention";
import { RotateInputsDialog } from "@/components/stacks/RotateInputsDialog";
import type {
  StackAttentionLevel,
  StackInfo,
  TemplateInputDeclaration,
} from "@mini-infra/types";

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
 * Presentation per attention level. A stack whose service has crashed is an
 * outage and must not look like "a newer template version exists" — before
 * these levels existed, every reason rendered in the same amber and the badge
 * could not tell the two apart.
 */
const ATTENTION_STYLES: Record<
  StackAttentionLevel,
  { label: string; className: string; icon: typeof IconAlertTriangle }
> = {
  critical: {
    label: "Needs attention",
    className:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
    icon: IconAlertCircle,
  },
  warning: {
    label: "Needs attention",
    className:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
    icon: IconAlertTriangle,
  },
  info: {
    label: "Update available",
    className:
      "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
    icon: IconArrowUpCircle,
  },
  none: {
    label: "Needs attention",
    className:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
    icon: IconAlertTriangle,
  },
};

/**
 * Single "needs attention" indicator rolling up live runtime issues, drift,
 * NATS drift, error status, and update-available into one affordance with the
 * reasons listed. Severity comes from the server-computed level.
 * Renders nothing when the stack is healthy and nothing is pending.
 */
export function NeedsAttentionBadge({
  stack,
  className,
}: {
  stack: StackInfo;
  className?: string;
}) {
  const attention = getStackAttention(stack);
  if (!attention.needsAttention) return null;

  const style = ATTENTION_STYLES[attention.level] ?? ATTENTION_STYLES.warning;
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
            {style.label}
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
  const upgrade = useUpgradeAndApplyStack();
  // While we look up whether the target version requires rotateOnUpgrade inputs.
  const [checking, setChecking] = useState(false);
  // Non-null once we know the upgrade needs input values → opens the dialog.
  const [rotateInputs, setRotateInputs] = useState<TemplateInputDeclaration[] | null>(null);

  const busy = upgrade.isPending || checking;

  async function handleClick() {
    setChecking(true);
    try {
      const inputs = await fetchStackUpgradeInputs(stackId);
      if (inputs.length > 0) {
        // Collect the required values first, then upgrade with them.
        setRotateInputs(inputs);
        return;
      }
      upgrade.mutate({ stackId, label });
    } catch {
      // Couldn't pre-fetch the required inputs — fall back to a plain upgrade.
      // If inputs are actually needed the server 400s with
      // STACK_INPUT_ROTATION_REQUIRED, surfaced by the global error toast.
      upgrade.mutate({ stackId, label });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={className}
        disabled={disabled || busy}
        onClick={handleClick}
        data-tour="stack-upgrade-button"
      >
        {busy ? (
          <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <IconArrowUp className="mr-1 h-4 w-4" />
        )}
        {children ?? "Upgrade & deploy"}
      </Button>
      <RotateInputsDialog
        open={rotateInputs !== null}
        onOpenChange={(open) => {
          if (!open) setRotateInputs(null);
        }}
        inputs={rotateInputs ?? []}
        isSaving={upgrade.isPending}
        onConfirm={(inputValues) => {
          upgrade.mutate(
            { stackId, label, inputValues },
            { onSuccess: () => setRotateInputs(null) },
          );
        }}
      />
    </>
  );
}
