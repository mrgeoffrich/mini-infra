import { useState } from "react";
import { IconArrowUp, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { TemplateInputDeclaration } from "@mini-infra/types";

interface RotateInputsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Friendly name for the stack/application, shown in the description. */
  stackName?: string;
  /** The `rotateOnUpgrade` inputs that must be supplied for this upgrade. */
  inputs: TemplateInputDeclaration[];
  onConfirm: (values: Record<string, string>) => void;
  isSaving: boolean;
}

/**
 * Collects the fresh input values an upgrade needs when the target template
 * version declares `rotateOnUpgrade` inputs (otherwise POST /upgrade 400s with
 * STACK_INPUT_ROTATION_REQUIRED). Mirrors StackParametersDialog's first-deploy
 * pattern: sensitive inputs render password-masked, and all fields are required.
 */
export function RotateInputsDialog({
  open,
  onOpenChange,
  stackName,
  inputs,
  onConfirm,
  isSaving,
}: RotateInputsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={isSaving ? undefined : onOpenChange}>
      {/* Remount the form each open so state re-initializes to empty. */}
      {open && (
        <RotateInputsDialogContent
          stackName={stackName}
          inputs={inputs}
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
          isSaving={isSaving}
        />
      )}
    </Dialog>
  );
}

function RotateInputsDialogContent({
  stackName,
  inputs,
  onConfirm,
  onOpenChange,
  isSaving,
}: Omit<RotateInputsDialogProps, "open">) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const input of inputs) initial[input.name] = "";
    return initial;
  });

  const allFilled = inputs.every((input) => (values[input.name] ?? "").trim().length > 0);

  function setField(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleConfirm() {
    if (!allFilled) return;
    onConfirm({ ...values });
  }

  return (
    <DialogContent className="sm:max-w-md" data-tour="rotate-inputs-dialog">
      <DialogHeader>
        <DialogTitle>Supply upgrade inputs</DialogTitle>
        <DialogDescription>
          {stackName ? `Upgrading ${stackName} needs ` : "This upgrade needs "}
          {inputs.length === 1 ? "a fresh value" : "fresh values"} for the following{" "}
          {inputs.length === 1 ? "input" : "inputs"}, which must be rotated on every
          upgrade.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        {inputs.map((input, index) => (
          <div key={input.name} data-tour="rotate-inputs-fields">
            {index > 0 && <Separator className="mb-4" />}
            <div className="space-y-1.5">
              <Label htmlFor={`rotate-input-${input.name}`} className="font-medium">
                {input.name}
              </Label>
              {input.description && (
                <p className="text-xs text-muted-foreground">{input.description}</p>
              )}
              <Input
                id={`rotate-input-${input.name}`}
                type={input.sensitive ? "password" : "text"}
                value={values[input.name] ?? ""}
                onChange={(e) => setField(input.name, e.target.value)}
                disabled={isSaving}
                autoComplete="off"
              />
            </div>
          </div>
        ))}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={isSaving || !allFilled}
          data-tour="rotate-inputs-confirm"
        >
          {isSaving ? (
            <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <IconArrowUp className="h-4 w-4 mr-2" />
          )}
          {isSaving ? "Upgrading..." : "Upgrade & deploy"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
