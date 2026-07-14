import { useState } from "react";
import { useUpgradeAndApplyStack, fetchStackUpgradeInputs } from "@/hooks/use-stacks";
import type { TemplateInputDeclaration } from "@mini-infra/types";

/**
 * The upgrade → (maybe collect rotateOnUpgrade inputs) → upgrade & apply chain,
 * as one reusable flow.
 *
 * Both entry points need it identically: the plain "Upgrade & deploy" button
 * (target = the template's current version) and the version picker (target = a
 * version the operator chose, possibly an older one). The only difference is the
 * `targetVersionId` threaded through — everything else, including which version's
 * inputs to prompt for, is the same. Keeping one flow means a fix to the input
 * gate can't land on one path and miss the other.
 *
 * Render {@link UpgradeRotateGate} alongside the consumer to surface the inputs
 * dialog this flow opens.
 */
export interface StackUpgradeFlow {
  busy: boolean;
  /** Kick off the upgrade. Omit `targetVersionId` to target the current version. */
  start: (targetVersionId?: string) => Promise<void>;
  // -- consumed by UpgradeRotateGate; not for direct use --
  rotateInputs: TemplateInputDeclaration[] | null;
  isUpgrading: boolean;
  cancelRotate: () => void;
  confirmRotate: (inputValues: Record<string, string>) => void;
}

export function useStackUpgradeFlow({
  stackId,
  label,
  onDone,
}: {
  stackId: string;
  /** Task-tracker label, e.g. `Upgrading ${app.name}`. */
  label: string;
  onDone?: () => void;
}): StackUpgradeFlow {
  const upgrade = useUpgradeAndApplyStack();
  // While we look up whether the target version requires rotateOnUpgrade inputs.
  const [checking, setChecking] = useState(false);
  // Non-null once we know the upgrade needs input values → opens the dialog.
  const [rotateInputs, setRotateInputs] = useState<TemplateInputDeclaration[] | null>(null);
  // Held across the dialog: the version the operator picked must survive the
  // detour through the inputs dialog, or confirming would silently upgrade to
  // the CURRENT version instead of the chosen one.
  const [pendingTargetVersionId, setPendingTargetVersionId] = useState<string | undefined>();

  async function start(targetVersionId?: string) {
    setChecking(true);
    setPendingTargetVersionId(targetVersionId);
    try {
      const inputs = await fetchStackUpgradeInputs(stackId, targetVersionId);
      if (inputs.length > 0) {
        // Collect the required values first, then upgrade with them.
        setRotateInputs(inputs);
        return;
      }
      upgrade.mutate({ stackId, label, targetVersionId }, { onSuccess: onDone });
    } catch {
      // Couldn't pre-fetch the required inputs — fall back to a plain upgrade.
      // If inputs are actually needed the server 400s with
      // STACK_INPUT_ROTATION_REQUIRED, surfaced by the global error toast.
      upgrade.mutate({ stackId, label, targetVersionId }, { onSuccess: onDone });
    } finally {
      setChecking(false);
    }
  }

  return {
    busy: upgrade.isPending || checking,
    start,
    rotateInputs,
    isUpgrading: upgrade.isPending,
    cancelRotate: () => setRotateInputs(null),
    confirmRotate: (inputValues) => {
      upgrade.mutate(
        { stackId, label, inputValues, targetVersionId: pendingTargetVersionId },
        {
          onSuccess: () => {
            setRotateInputs(null);
            onDone?.();
          },
        },
      );
    },
  };
}
