import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { IconLoader2, IconRocket } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useEnvironments } from "@/hooks/use-environments";
import { useInstantiateTemplate } from "@/hooks/use-stack-templates";
import type {
  StackParameterValue,
  StackTemplateInfo,
} from "@mini-infra/types";

interface InstantiateTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: StackTemplateInfo;
}

/**
 * "Install" dialog reachable from the template detail page: collects a name,
 * an environment (for env/any-scoped templates), parameter overrides, and any
 * input values, then calls POST /:id/instantiate. On success it jumps to the
 * new stack's detail page. Mirrors the field-rendering of StackParametersDialog.
 */
export function InstantiateTemplateDialog({
  open,
  onOpenChange,
  template,
}: InstantiateTemplateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <InstantiateTemplateDialogContent template={template} onOpenChange={onOpenChange} />
      )}
    </Dialog>
  );
}

function InstantiateTemplateDialogContent({
  template,
  onOpenChange,
}: {
  template: StackTemplateInfo;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const instantiate = useInstantiateTemplate();
  const { data: envData } = useEnvironments();

  const version = template.currentVersion ?? undefined;
  const parameters = useMemo(() => version?.parameters ?? [], [version]);
  const inputs = useMemo(() => (version?.inputs ?? []).filter((i) => i.required), [version]);
  const defaultParamValues = version?.defaultParameterValues ?? {};

  const needsEnvironment = template.scope !== "host";
  // Only environments whose network type matches the template (or templates
  // with no fixed network type) are valid targets — matches the server gate.
  const environments = useMemo(() => {
    const all = envData?.environments ?? [];
    return template.networkType
      ? all.filter((e) => e.networkType === template.networkType)
      : all;
  }, [envData, template.networkType]);

  const [name, setName] = useState("");
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [paramValues, setParamValues] = useState<Record<string, StackParameterValue>>(() => {
    const initial: Record<string, StackParameterValue> = {};
    for (const p of parameters) initial[p.name] = defaultParamValues[p.name] ?? p.default;
    return initial;
  });
  const [inputValues, setInputValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const i of inputs) initial[i.name] = "";
    return initial;
  });

  const missingEnv = needsEnvironment && template.scope === "environment" && !environmentId;
  const missingInputs = inputs.some((i) => (inputValues[i.name] ?? "").trim().length === 0);
  const saving = instantiate.isPending;

  function coerceParams(): Record<string, StackParameterValue> {
    const coerced: Record<string, StackParameterValue> = {};
    for (const p of parameters) {
      const raw = paramValues[p.name] ?? p.default;
      if (p.type === "number") coerced[p.name] = Number(raw);
      else if (p.type === "boolean") coerced[p.name] = Boolean(raw);
      else coerced[p.name] = String(raw);
    }
    return coerced;
  }

  async function handleInstall() {
    if (missingEnv || missingInputs) return;
    try {
      const stack = await instantiate.mutateAsync({
        templateId: template.id,
        name: name.trim() || undefined,
        environmentId: environmentId || undefined,
        parameterValues: parameters.length > 0 ? coerceParams() : undefined,
        inputValues: inputs.length > 0 ? { ...inputValues } : undefined,
      });
      toast.success(`Installing ${template.displayName}`);
      onOpenChange(false);
      navigate(`/stacks/${stack.id}`);
    } catch {
      // Global MutationCache.onError toasts the actionable error; keep the
      // dialog open so the operator can adjust and retry.
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Install {template.displayName}</DialogTitle>
        <DialogDescription>
          Create a stack from this template&apos;s current published version.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label htmlFor="instantiate-name">Name (optional)</Label>
          <Input
            id="instantiate-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={template.name}
            disabled={saving}
          />
        </div>

        {needsEnvironment && (
          <div className="space-y-1.5">
            <Label htmlFor="instantiate-env">
              Environment{template.scope === "environment" ? "" : " (optional)"}
            </Label>
            <Select
              value={environmentId}
              onValueChange={setEnvironmentId}
              disabled={saving}
            >
              <SelectTrigger id="instantiate-env">
                <SelectValue placeholder="Select an environment" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.name} ({env.networkType})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {parameters.length > 0 && (
          <>
            <Separator />
            {parameters.map((param) => (
              <div key={param.name} className="space-y-1.5">
                <Label htmlFor={`instantiate-param-${param.name}`} className="font-medium">
                  {param.name}
                </Label>
                {param.description && (
                  <p className="text-xs text-muted-foreground">{param.description}</p>
                )}
                {param.type === "boolean" ? (
                  <div className="flex items-center gap-2 pt-1">
                    <Switch
                      id={`instantiate-param-${param.name}`}
                      checked={Boolean(paramValues[param.name] ?? param.default)}
                      onCheckedChange={(v) =>
                        setParamValues((prev) => ({ ...prev, [param.name]: v }))
                      }
                      disabled={saving}
                    />
                  </div>
                ) : (
                  <Input
                    id={`instantiate-param-${param.name}`}
                    type={param.type === "number" ? "number" : "text"}
                    value={String(paramValues[param.name] ?? param.default)}
                    onChange={(e) =>
                      setParamValues((prev) => ({ ...prev, [param.name]: e.target.value }))
                    }
                    disabled={saving}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {inputs.length > 0 && (
          <>
            <Separator />
            {inputs.map((input) => (
              <div key={input.name} className="space-y-1.5">
                <Label htmlFor={`instantiate-input-${input.name}`} className="font-medium">
                  {input.name}
                </Label>
                {input.description && (
                  <p className="text-xs text-muted-foreground">{input.description}</p>
                )}
                <Input
                  id={`instantiate-input-${input.name}`}
                  type={input.sensitive ? "password" : "text"}
                  value={inputValues[input.name] ?? ""}
                  onChange={(e) =>
                    setInputValues((prev) => ({ ...prev, [input.name]: e.target.value }))
                  }
                  disabled={saving}
                  autoComplete="off"
                />
              </div>
            ))}
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleInstall} disabled={saving || missingEnv || missingInputs}>
          {saving ? (
            <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <IconRocket className="h-4 w-4 mr-2" />
          )}
          Install
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
