import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconPlus, IconEdit, IconTrash, IconPuzzle } from "@tabler/icons-react";
import type {
  StackTemplateServiceInfo,
  StackServiceDefinition,
  StackServiceType,
} from "@mini-infra/types";
import { ServiceEditDrawer } from "./service-drawer/service-edit-drawer";
import { mapServiceInfoToDefinition } from "@/lib/application-draft";
import { AddonBadge } from "@/components/stacks/addon-badge";
import { AttachAddonDialog } from "@/components/stacks/attach-addon-dialog";

interface TemplateServicesSectionProps {
  services: StackTemplateServiceInfo[];
  allServiceNames: string[];
  readOnly?: boolean;
  onServicesChange: (services: StackServiceDefinition[]) => void;
}

const TYPE_BADGE_CLASSES: Record<StackServiceType, string> = {
  Stateful: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  StatelessWeb: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  AdoptedWeb: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  Pool: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  JobPool: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-300",
};

const TYPE_BORDER_CLASSES: Record<StackServiceType, string> = {
  Stateful: "border-l-blue-500",
  StatelessWeb: "border-l-green-500",
  AdoptedWeb: "border-l-purple-500",
  Pool: "border-l-amber-500",
  JobPool: "border-l-rose-500",
};

export function TemplateServicesSection({
  services,
  readOnly = false,
  onServicesChange,
}: TemplateServicesSectionProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  // The service whose Add-ons dialog is open (index into `sortedServices`), or
  // null when closed. Attach/remove is order-preserving, so the index stays
  // valid across a save/refetch.
  const [addonServiceIndex, setAddonServiceIndex] = useState<number | null>(
    null,
  );

  const sortedServices = [...services].sort((a, b) => a.order - b.order);

  const editingService =
    editingIndex !== null
      ? mapServiceInfoToDefinition(sortedServices[editingIndex]!)
      : null;

  const drawerOpen = isAdding || editingIndex !== null;
  const drawerService = isAdding ? null : editingService;

  const addonService =
    addonServiceIndex !== null ? sortedServices[addonServiceIndex] ?? null : null;
  const addonServiceAttached = (addonService?.addons ?? {}) as Record<
    string,
    unknown
  >;
  const addonServiceAttachedIds = Object.keys(addonServiceAttached);

  function handleSave(updated: StackServiceDefinition) {
    const definitions = sortedServices.map(mapServiceInfoToDefinition);

    if (isAdding) {
      onServicesChange([...definitions, updated]);
    } else if (editingIndex !== null) {
      const newDefs = [...definitions];
      newDefs[editingIndex] = updated;
      onServicesChange(newDefs);
    }

    setIsAdding(false);
    setEditingIndex(null);
  }

  function handleDelete(index: number) {
    const definitions = sortedServices
      .filter((_, i) => i !== index)
      .map((svc, i) => ({ ...mapServiceInfoToDefinition(svc), order: i + 1 }));
    onServicesChange(definitions);
  }

  function handleDrawerOpenChange(open: boolean) {
    if (!open) {
      setIsAdding(false);
      setEditingIndex(null);
    }
  }

  // Persist a change to one service's `addons` block through the same
  // `onServicesChange` → draft-save path every other edit uses. Rebuilding the
  // whole list via the canonical mapper keeps every OTHER service's per-service
  // fields intact (Part A). An empty map is written as `undefined` so the addon
  // block disappears rather than persisting as `{}`.
  function persistServiceAddons(
    index: number,
    nextAddons: Record<string, unknown>,
  ) {
    const definitions = sortedServices.map(mapServiceInfoToDefinition);
    const svc = definitions[index];
    if (!svc) return;
    definitions[index] = {
      ...svc,
      addons:
        Object.keys(nextAddons).length > 0 ? nextAddons : undefined,
    };
    onServicesChange(definitions);
  }

  function handleAddonAttach(
    addonId: string,
    config: Record<string, unknown>,
  ) {
    if (addonServiceIndex === null) return;
    persistServiceAddons(addonServiceIndex, {
      ...addonServiceAttached,
      [addonId]: config,
    });
  }

  function handleAddonRemove(addonId: string) {
    if (addonServiceIndex === null) return;
    const next = { ...addonServiceAttached };
    delete next[addonId];
    persistServiceAddons(addonServiceIndex, next);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Services ({services.length})</h3>
        {!readOnly && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setIsAdding(true)}
          >
            <IconPlus className="mr-1 h-4 w-4" />
            Add Service
          </Button>
        )}
      </div>

      {sortedServices.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No services defined. Add a service to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedServices.map((svc, index) => {
            const portCount = svc.containerConfig.ports?.length ?? 0;
            const envCount = Object.keys(svc.containerConfig.env ?? {}).length;
            const mountCount = svc.containerConfig.mounts?.length ?? 0;
            const addonIds = Object.keys(
              (svc.addons ?? {}) as Record<string, unknown>,
            );

            return (
              // A clickable card that also hosts action buttons (edit / delete /
              // add-ons). It must NOT be a <button> — nesting the action
              // <button>s inside another <button> is invalid HTML and makes
              // real clicks on them resolve unreliably (the add-ons button would
              // sometimes open the edit drawer instead). A div with role=button
              // keeps the whole-card "click to edit" affordance while letting the
              // nested buttons behave normally.
              <div
                key={svc.id}
                role={readOnly ? undefined : "button"}
                tabIndex={readOnly ? undefined : 0}
                onClick={() => !readOnly && setEditingIndex(index)}
                onKeyDown={(e) => {
                  if (readOnly) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setEditingIndex(index);
                  }
                }}
                className={`w-full text-left rounded-md border border-l-4 ${TYPE_BORDER_CLASSES[svc.serviceType]} bg-card p-3 transition-colors ${readOnly ? "cursor-default" : "cursor-pointer hover:bg-muted/30"}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{svc.serviceName}</span>
                  <Badge className={TYPE_BADGE_CLASSES[svc.serviceType]}>
                    {svc.serviceType}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    #{svc.order}
                  </span>
                  {svc.dependsOn.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      → {svc.dependsOn.join(", ")}
                    </span>
                  )}
                  {!readOnly && (
                    <div
                      className="ml-auto flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setAddonServiceIndex(index)}
                        aria-label={`Add-ons for ${svc.serviceName}`}
                        title="Add-ons"
                      >
                        <IconPuzzle className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setEditingIndex(index)}
                        aria-label={`Edit ${svc.serviceName}`}
                      >
                        <IconEdit className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(index)}
                        aria-label={`Delete ${svc.serviceName}`}
                      >
                        <IconTrash className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>

                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    <span className="font-medium text-foreground">Image:</span>{" "}
                    {svc.dockerImage}:{svc.dockerTag}
                  </span>
                  <span>
                    <span className="font-medium text-foreground">Ports:</span>{" "}
                    {portCount === 0 ? "none" : `${portCount} mapping${portCount !== 1 ? "s" : ""}`}
                  </span>
                  <span>
                    <span className="font-medium text-foreground">Env vars:</span>{" "}
                    {envCount === 0 ? "none" : envCount}
                  </span>
                  {mountCount > 0 && (
                    <span>
                      <span className="font-medium text-foreground">Mounts:</span>{" "}
                      {mountCount}
                    </span>
                  )}
                  {svc.routing && (
                    <span className="col-span-2">
                      <span className="font-medium text-foreground">Routing:</span>{" "}
                      {svc.routing.hostname}:{svc.routing.listeningPort}
                    </span>
                  )}
                  {svc.adoptedContainer && (
                    <span className="col-span-2">
                      <span className="font-medium text-foreground">Adopts:</span>{" "}
                      {svc.adoptedContainer.containerName}:
                      {svc.adoptedContainer.listeningPort}
                    </span>
                  )}
                  {addonIds.length > 0 && (
                    <span className="col-span-2 flex flex-wrap items-center gap-1">
                      <span className="font-medium text-foreground">
                        Add-ons:
                      </span>{" "}
                      {addonIds.map((id) => (
                        <AddonBadge key={id} addonName={id} />
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ServiceEditDrawer
        open={drawerOpen}
        onOpenChange={handleDrawerOpenChange}
        service={drawerService}
        onSave={handleSave}
      />

      {/* Per-service Add-ons authoring. Only mounted while editing the draft
          (the affordance button is gated on `!readOnly`); attaching/removing
          writes the service's `addons` block through `onServicesChange`. The
          dialog itself gates each addon by service type + connectivity. */}
      {addonService && (
        <AttachAddonDialog
          open={addonServiceIndex !== null}
          onOpenChange={(open) => {
            if (!open) setAddonServiceIndex(null);
          }}
          serviceName={addonService.serviceName}
          serviceType={addonService.serviceType}
          attachedAddonIds={addonServiceAttachedIds}
          onAttach={handleAddonAttach}
          onRemove={handleAddonRemove}
        />
      )}
    </div>
  );
}
