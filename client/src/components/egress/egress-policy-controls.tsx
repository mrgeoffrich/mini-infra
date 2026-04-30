/**
 * Shared egress policy controls and badges.
 *
 * Extracted from the (now-deleted) egress-policy-card.tsx so the per-stack
 * detail page and any other surface can render the same toggles without
 * pulling in the card wrapper.
 */

import { useState } from "react";
import {
  IconAlertCircle,
  IconCheck,
  IconX,
  IconEye,
  IconLock,
  IconLockOpen,
  IconLoader2,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";
import { usePatchEgressPolicy } from "@/hooks/use-egress";
import type {
  EgressPolicySummary,
  EgressGatewayHealthEvent,
} from "@mini-infra/types";

// ====================
// Gateway health badge
// ====================

export function GatewayHealthBadge({
  health,
}: {
  health: EgressGatewayHealthEvent | null;
}) {
  if (!health) {
    return (
      <Badge variant="outline" className="text-xs text-muted-foreground">
        Unknown
      </Badge>
    );
  }

  if (!health.ok) {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      >
        <IconX className="h-3 w-3 mr-1" />
        Error
      </Badge>
    );
  }

  const hasDrift =
    health.rulesVersion !== (health.appliedRulesVersion ?? -1) ||
    health.containerMapVersion !== (health.appliedContainerMapVersion ?? -1);

  if (hasDrift) {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
      >
        <IconAlertCircle className="h-3 w-3 mr-1" />
        Drift
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    >
      <IconCheck className="h-3 w-3 mr-1" />
      Healthy
    </Badge>
  );
}

// ====================
// Mode + default-action badges (read-only display)
// ====================

export function ModeBadge({ mode }: { mode: "detect" | "enforce" }) {
  if (mode === "enforce") {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300"
      >
        <IconLock className="h-3 w-3 mr-1" />
        Enforce
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
    >
      <IconEye className="h-3 w-3 mr-1" />
      Detect
    </Badge>
  );
}

export function DefaultActionBadge({ action }: { action: "allow" | "block" }) {
  if (action === "block") {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      >
        <IconLock className="h-3 w-3 mr-1" />
        Block by default
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    >
      <IconLockOpen className="h-3 w-3 mr-1" />
      Allow by default
    </Badge>
  );
}

export function RuleSourceBadge({ source }: { source: string }) {
  const variants: Record<string, string> = {
    user: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
    observed:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
    template:
      "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  };
  return (
    <Badge
      variant="outline"
      className={`text-xs capitalize ${variants[source] ?? ""}`}
    >
      {source}
    </Badge>
  );
}

// ====================
// Mode toggle (write mode)
// ====================

interface ModeToggleProps {
  policy: EgressPolicySummary;
  onOpenPromoteWizard: () => void;
}

export function ModeToggle({ policy, onOpenPromoteWizard }: ModeToggleProps) {
  const patchPolicy = usePatchEgressPolicy();
  const [confirmDetectOpen, setConfirmDetectOpen] = useState(false);

  const handleValueChange = (value: string) => {
    if (!value) return;
    if (value === policy.mode) return;

    if (value === "enforce") {
      onOpenPromoteWizard();
    } else {
      setConfirmDetectOpen(true);
    }
  };

  const handleConfirmDetect = async () => {
    try {
      await patchPolicy.mutateAsync({
        policyId: policy.id,
        body: { mode: "detect" },
      });
      toast.success("Policy switched to Detect mode");
      setConfirmDetectOpen(false);
    } catch (err) {
      toast.error(
        `Failed to switch mode: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        value={policy.mode}
        onValueChange={handleValueChange}
        disabled={patchPolicy.isPending}
        className="h-7"
      >
        <ToggleGroupItem value="detect" className="h-6 text-xs px-3">
          <IconEye className="h-3 w-3 mr-1" />
          Detect
        </ToggleGroupItem>
        <ToggleGroupItem value="enforce" className="h-6 text-xs px-3">
          <IconLock className="h-3 w-3 mr-1" />
          Enforce
        </ToggleGroupItem>
      </ToggleGroup>

      <Dialog open={confirmDetectOpen} onOpenChange={setConfirmDetectOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Switch to Detect mode?</DialogTitle>
            <DialogDescription>
              The policy will stop blocking traffic and will only observe. You
              can switch back to Enforce at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDetectOpen(false)}
              disabled={patchPolicy.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmDetect}
              disabled={patchPolicy.isPending}
            >
              {patchPolicy.isPending && (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Switch to Detect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ====================
// Default action toggle (write mode)
// ====================

interface DefaultActionToggleProps {
  policy: EgressPolicySummary;
}

export function DefaultActionToggle({ policy }: DefaultActionToggleProps) {
  const patchPolicy = usePatchEgressPolicy();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"allow" | "block" | null>(
    null,
  );

  const handleValueChange = (value: string) => {
    if (!value || value === policy.defaultAction) return;
    setPendingAction(value as "allow" | "block");
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    if (!pendingAction) return;
    try {
      await patchPolicy.mutateAsync({
        policyId: policy.id,
        body: { defaultAction: pendingAction },
      });
      toast.success(
        `Default action set to ${pendingAction === "block" ? "Block" : "Allow"}`,
      );
      setConfirmOpen(false);
      setPendingAction(null);
    } catch (err) {
      toast.error(
        `Failed to update default action: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        value={policy.defaultAction}
        onValueChange={handleValueChange}
        disabled={patchPolicy.isPending || policy.mode === "detect"}
        className="h-7"
      >
        <ToggleGroupItem value="allow" className="h-6 text-xs px-3">
          Allow
        </ToggleGroupItem>
        <ToggleGroupItem value="block" className="h-6 text-xs px-3">
          Block
        </ToggleGroupItem>
      </ToggleGroup>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Change default action to{" "}
              {pendingAction === "block" ? "Block" : "Allow"}?
            </DialogTitle>
            <DialogDescription>
              {pendingAction === "block"
                ? "Setting default to Block means traffic without an explicit allow rule will be blocked. Existing observed traffic that hasn't been added as a rule will be blocked."
                : "Setting default to Allow means unmatched traffic will be permitted. This weakens the enforce posture."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={patchPolicy.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={pendingAction === "block" ? "destructive" : "default"}
              onClick={handleConfirm}
              disabled={patchPolicy.isPending}
            >
              {patchPolicy.isPending && (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
