import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconPlus, IconEdit, IconTrash } from "@tabler/icons-react";
import type {
  StackTemplateServiceInfo,
  StackServiceDefinition,
  StackServiceType,
} from "@mini-infra/types";
import { ServiceEditDrawer } from "./service-drawer/service-edit-drawer";

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
};

const TYPE_BORDER_CLASSES: Record<StackServiceType, string> = {
  Stateful: "border-l-blue-500",
  StatelessWeb: "border-l-green-500",
  AdoptedWeb: "border-l-purple-500",
};

function toServiceDefinition(
  info: StackTemplateServiceInfo,
): StackServiceDefinition {
  return {
    serviceName: info.serviceName,
    serviceType: info.serviceType,
    dockerImage: info.dockerImage,
    dockerTag: info.dockerTag,
    containerConfig: info.containerConfig,
    initCommands: info.initCommands ?? undefined,
    dependsOn: info.dependsOn,
    order: info.order,
    routing: info.routing ?? undefined,
    adoptedContainer: info.adoptedContainer ?? undefined,
  };
}

export function TemplateServicesSection({
  services,
  readOnly = false,
  onServicesChange,
}: TemplateServicesSectionProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const sortedServices = [...services].sort((a, b) => a.order - b.order);

  const editingService =
    editingIndex !== null
      ? toServiceDefinition(sortedServices[editingIndex]!)
      : null;

  const drawerOpen = isAdding || editingIndex !== null;
  const drawerService = isAdding ? null : editingService;

  function handleSave(updated: StackServiceDefinition) {
    const definitions = sortedServices.map(toServiceDefinition);

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
      .map((svc, i) => ({ ...toServiceDefinition(svc), order: i + 1 }));
    onServicesChange(definitions);
  }

  function handleDrawerOpenChange(open: boolean) {
    if (!open) {
      setIsAdding(false);
      setEditingIndex(null);
    }
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

            return (
              <button
                type="button"
                key={svc.id}
                onClick={() => !readOnly && setEditingIndex(index)}
                disabled={readOnly}
                className={`w-full text-left rounded-md border border-l-4 ${TYPE_BORDER_CLASSES[svc.serviceType]} bg-card p-3 transition-colors hover:bg-muted/30 disabled:cursor-default disabled:hover:bg-card`}
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
                        onClick={() => setEditingIndex(index)}
                      >
                        <IconEdit className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(index)}
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
                </div>
              </button>
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
    </div>
  );
}
