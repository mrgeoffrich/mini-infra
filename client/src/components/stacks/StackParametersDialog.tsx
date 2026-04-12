import { useEffect, useState } from "react";
import { IconLoader2, IconRocket } from "@tabler/icons-react";
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
import { Switch } from "@/components/ui/switch";
import type { StackParameterDefinition, StackParameterValue } from "@mini-infra/types";

interface StackParametersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  parameters: StackParameterDefinition[];
  currentValues: Record<string, StackParameterValue>;
  onConfirm: (values: Record<string, StackParameterValue>) => void;
  isSaving: boolean;
}

export function StackParametersDialog({
  open,
  onOpenChange,
  stackName,
  parameters,
  currentValues,
  onConfirm,
  isSaving,
}: StackParametersDialogProps) {
  const [localValues, setLocalValues] = useState<Record<string, StackParameterValue>>({});

  useEffect(() => {
    if (open) {
      const initial: Record<string, StackParameterValue> = {};
      for (const param of parameters) {
        initial[param.name] = currentValues[param.name] ?? param.default;
      }
      setLocalValues(initial);
    }
  }, [open, parameters, currentValues]);

  function handleConfirm() {
    const coerced: Record<string, StackParameterValue> = {};
    for (const param of parameters) {
      const raw = localValues[param.name] ?? param.default;
      if (param.type === "number") {
        coerced[param.name] = Number(raw);
      } else if (param.type === "boolean") {
        coerced[param.name] = Boolean(raw);
      } else {
        coerced[param.name] = String(raw);
      }
    }
    onConfirm(coerced);
  }

  function setField(name: string, value: StackParameterValue) {
    setLocalValues((prev) => ({ ...prev, [name]: value }));
  }

  return (
    <Dialog open={open} onOpenChange={isSaving ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {stackName}</DialogTitle>
          <DialogDescription>
            Review and set configuration values before deploying. You can change
            these later by editing the stack.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {parameters.map((param, index) => (
            <div key={param.name}>
              {index > 0 && <Separator className="mb-4" />}
              <div className="space-y-1.5">
                <Label htmlFor={`param-${param.name}`} className="font-medium">
                  {param.name}
                </Label>
                {param.description && (
                  <p className="text-xs text-muted-foreground">{param.description}</p>
                )}
                {param.type === "boolean" ? (
                  <div className="flex items-center gap-2 pt-1">
                    <Switch
                      id={`param-${param.name}`}
                      checked={Boolean(localValues[param.name] ?? param.default)}
                      onCheckedChange={(v) => setField(param.name, v)}
                      disabled={isSaving}
                    />
                    <span className="text-sm text-muted-foreground">
                      {(localValues[param.name] ?? param.default) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                ) : param.type === "number" ? (
                  <Input
                    id={`param-${param.name}`}
                    type="number"
                    value={String(localValues[param.name] ?? param.default)}
                    onChange={(e) => setField(param.name, e.target.value)}
                    disabled={isSaving}
                  />
                ) : (
                  <Input
                    id={`param-${param.name}`}
                    type={param.name.toLowerCase().includes("password") ? "password" : "text"}
                    value={String(localValues[param.name] ?? param.default)}
                    onChange={(e) => setField(param.name, e.target.value)}
                    disabled={isSaving}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isSaving}>
            {isSaving ? (
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <IconRocket className="h-4 w-4 mr-2" />
            )}
            {isSaving ? "Saving..." : "Save & Deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
