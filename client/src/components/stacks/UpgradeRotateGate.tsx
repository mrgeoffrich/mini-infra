import { RotateInputsDialog } from "@/components/stacks/RotateInputsDialog";
import type { StackUpgradeFlow } from "@/hooks/use-stack-upgrade-flow";

/**
 * Renders the rotateOnUpgrade inputs dialog for a `useStackUpgradeFlow`.
 *
 * Both upgrade entry points — the "Upgrade & deploy" button and the version
 * picker — mount this, so the input-collection step behaves identically whether
 * the operator is taking the current version or choosing a specific one.
 */
export function UpgradeRotateGate({ flow }: { flow: StackUpgradeFlow }) {
  return (
    <RotateInputsDialog
      open={flow.rotateInputs !== null}
      onOpenChange={(open) => {
        if (!open) flow.cancelRotate();
      }}
      inputs={flow.rotateInputs ?? []}
      isSaving={flow.isUpgrading}
      onConfirm={flow.confirmRotate}
    />
  );
}
