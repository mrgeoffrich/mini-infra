import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import type {
  AddonCatalogEntry,
  AddonConfigFieldDescriptor,
  StackServiceType,
} from "@mini-infra/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TagListInput } from "@/components/ui/tag-list-input";
import { useAddonCatalog } from "@/hooks/use-addon-catalog";
import { useServiceConnectivity } from "@/hooks/use-settings-validation";
import {
  buildAddonConfig,
  getAddonAvailability,
  initialFormState,
  type AddonFieldValue,
  type AddonFormState,
  type ConnectivityState,
} from "./addon-applicability";

// ---------------------------------------------------------------------------
// Shared "attach add-on" component (§4.3 of the addon-authoring-ui plan).
//
// Self-contained: it fetches the catalog and the connectivity it gates on
// itself, so it can be dropped onto the Overview "Add-ons" card here AND onto
// a Services-tab row in Phase 4 without either surface re-implementing the
// applicability/gating logic. All gating lives in `getAddonAvailability`
// (pure, in `addon-applicability.ts`) so both surfaces gate identically.
// ---------------------------------------------------------------------------

interface AttachAddonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The service the addon attaches to (name for copy; type for gating). */
  serviceName: string;
  serviceType: StackServiceType;
  /** Ids already declared on the service — shown as "Attached", not offered. */
  attachedAddonIds: string[];
  /** Persist an attach: write `services[].addons[addonId] = config`. */
  onAttach: (addonId: string, config: Record<string, unknown>) => void;
  /** Persist a remove: delete `services[].addons[addonId]`. */
  onRemove: (addonId: string) => void;
  /** Republish in flight — disables the action buttons. */
  isPending?: boolean;
  /**
   * Which surface hosts the dialog — drives copy so it says "application" on an
   * application screen and "template" in the template authoring editor (where
   * there's no deployed stack to redeploy). Defaults to "application".
   */
  context?: "application" | "template";
}

export function AttachAddonDialog({
  open,
  onOpenChange,
  serviceName,
  serviceType,
  attachedAddonIds,
  onAttach,
  onRemove,
  isPending = false,
  context = "application",
}: AttachAddonDialogProps) {
  const catalogQuery = useAddonCatalog(open);
  const { data: tailscaleConnectivity } = useServiceConnectivity("tailscale", {
    enabled: open,
  });

  // Live connectivity keyed by connected-service tag, matching how
  // `connect-card.tsx` reads the most-recent status. Only `"down"` blocks an
  // addon; an unreported status is `"unknown"` (usable — server re-validates).
  const tailscaleStatus = tailscaleConnectivity?.data?.[0]?.status;
  const connectivity = useMemo<Record<string, ConnectivityState>>(() => {
    const down =
      tailscaleStatus === "failed" ||
      tailscaleStatus === "timeout" ||
      tailscaleStatus === "unreachable";
    return {
      tailscale: down ? "down" : tailscaleStatus ? "up" : "unknown",
    };
  }, [tailscaleStatus]);

  const addons = useMemo(
    () => catalogQuery.data?.addons ?? [],
    [catalogQuery.data?.addons],
  );

  const attachedSet = useMemo(
    () => new Set(attachedAddonIds),
    [attachedAddonIds],
  );

  // The addon currently being configured (expanded inline) + its form state.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formState, setFormState] = useState<AddonFormState>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const selectedAddon = useMemo(
    () => addons.find((a) => a.id === selectedId) ?? null,
    [addons, selectedId],
  );

  const startConfiguring = (addon: AddonCatalogEntry) => {
    setSelectedId(addon.id);
    setFormState(initialFormState(addon.configFields));
    setErrors({});
  };

  const cancelConfiguring = () => {
    setSelectedId(null);
    setFormState({});
    setErrors({});
  };

  // Reset the transient selection whenever the dialog closes so re-opening
  // starts clean rather than mid-edit — done in the close handler (not an
  // effect) to avoid a cascading-render setState-in-effect.
  const handleOpenChange = (next: boolean) => {
    if (!next) cancelConfiguring();
    onOpenChange(next);
  };

  const setField = (name: string, value: AddonFieldValue) => {
    setFormState((prev) => ({ ...prev, [name]: value }));
  };

  const confirmAttach = () => {
    if (!selectedAddon) return;
    const result = buildAddonConfig(selectedAddon.configFields, formState);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onAttach(selectedAddon.id, result.config);
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add-ons for {serviceName}</DialogTitle>
          <DialogDescription>
            {context === "template"
              ? "Attach a capability to this service. Changes are saved to the template draft and apply to stacks installed from it."
              : "Attach a capability to this service. Changes are saved to the application and take effect on its next redeploy."}
          </DialogDescription>
        </DialogHeader>

        {catalogQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : catalogQuery.isError ? (
          <Alert variant="destructive">
            <IconAlertTriangle className="h-4 w-4" />
            <AlertTitle>Couldn&apos;t load add-ons</AlertTitle>
            <AlertDescription>
              The add-on catalog failed to load. Try reopening this dialog.
            </AlertDescription>
          </Alert>
        ) : addons.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No add-ons are registered on this instance.
          </p>
        ) : (
          <ul className="space-y-2 max-h-[24rem] overflow-y-auto">
            {addons.map((addon) => {
              const attached = attachedSet.has(addon.id);
              const availability = getAddonAvailability(
                addon,
                serviceType,
                connectivity,
              );
              const isSelected = selectedId === addon.id;
              return (
                <li
                  key={addon.id}
                  data-testid={`addon-row-${addon.id}`}
                  className="rounded-md border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{addon.id}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {addon.mode === "env-injection" ? "env" : "sidecar"}
                        </Badge>
                        {attached && (
                          <Badge className="text-[10px]">Attached</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {addon.description}
                      </p>
                      {!attached && !availability.available && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                          {availability.reason}
                          {availability.fix && (
                            <>
                              {" — "}
                              <Link
                                to={availability.fix.to}
                                className="underline underline-offset-2"
                              >
                                {availability.fix.label}
                              </Link>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0">
                      {attached ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onRemove(addon.id)}
                          disabled={isPending}
                          aria-label={`Remove ${addon.id}`}
                        >
                          <IconTrash className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => startConfiguring(addon)}
                          disabled={!availability.available || isPending || isSelected}
                        >
                          {isSelected ? "Configuring…" : "Configure"}
                        </Button>
                      )}
                    </div>
                  </div>

                  {isSelected && (
                    <div className="mt-3 border-t pt-3">
                      <AddonConfigForm
                        fields={addon.configFields}
                        state={formState}
                        errors={errors}
                        onChange={setField}
                      />
                      <div className="flex justify-end gap-2 mt-3">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={cancelConfiguring}
                          disabled={isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={confirmAttach}
                          disabled={isPending}
                        >
                          Attach
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders one control per `configField` and reports edits back through
 * `onChange`. The control kind is chosen by descriptor `type`; validation
 * (required / min / max / pattern) is enforced on submit by `buildAddonConfig`,
 * with any resulting per-field message surfaced here from `errors`.
 */
function AddonConfigForm({
  fields,
  state,
  errors,
  onChange,
}: {
  fields: AddonConfigFieldDescriptor[];
  state: AddonFormState;
  errors: Record<string, string>;
  onChange: (name: string, value: AddonFieldValue) => void;
}) {
  if (fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This add-on has no configuration.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {fields.map((field) => {
        const value = state[field.name];
        const error = errors[field.name];
        const controlId = `addon-field-${field.name}`;
        return (
          <div key={field.name} className="space-y-1">
            {field.type === "boolean" ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={controlId}
                  checked={value === true}
                  onCheckedChange={(checked) =>
                    onChange(field.name, checked === true)
                  }
                />
                <Label htmlFor={controlId} className="text-sm font-normal">
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </Label>
              </div>
            ) : (
              <>
                <Label htmlFor={controlId} className="text-sm">
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </Label>
                {field.type === "string[]" ? (
                  <TagListInput
                    ariaLabel={field.label}
                    value={Array.isArray(value) ? value : []}
                    onChange={(next) => onChange(field.name, next)}
                    placeholder={field.placeholder ?? "Add value and press Enter"}
                    validate={
                      field.pattern
                        ? (raw) =>
                            new RegExp(field.pattern as string).test(raw)
                              ? null
                              : `Must match ${field.pattern}`
                        : undefined
                    }
                  />
                ) : (
                  <Input
                    id={controlId}
                    type={field.type === "number" ? "number" : "text"}
                    inputMode={field.type === "number" ? "numeric" : undefined}
                    min={field.type === "number" ? field.min : undefined}
                    max={field.type === "number" ? field.max : undefined}
                    placeholder={field.placeholder}
                    value={typeof value === "string" ? value : ""}
                    onChange={(e) => onChange(field.name, e.target.value)}
                  />
                )}
              </>
            )}
            {field.help && (
              <p className="text-xs text-muted-foreground">{field.help}</p>
            )}
            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
