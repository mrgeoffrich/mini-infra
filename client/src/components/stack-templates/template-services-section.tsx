import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconPlus, IconEdit, IconTrash, IconGripVertical } from "@tabler/icons-react";
import type { StackTemplateServiceInfo, StackServiceDefinition } from "@mini-infra/types";
import { ServiceEditDialog } from "./service-edit-dialog";

interface TemplateServicesSectionProps {
  services: StackTemplateServiceInfo[];
  allServiceNames: string[];
  readOnly?: boolean;
  onServicesChange: (services: StackServiceDefinition[]) => void;
}

function serviceTypeBadge(type: string) {
  if (type === "Stateful") {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
        Stateful
      </Badge>
    );
  }
  return (
    <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
      StatelessWeb
    </Badge>
  );
}

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
  };
}

export function TemplateServicesSection({
  services,
  allServiceNames,
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

  const dialogOpen = isAdding || editingIndex !== null;
  const dialogService = isAdding ? null : editingService;

  const otherServiceNames =
    editingIndex !== null
      ? allServiceNames.filter(
          (n) => n !== (sortedServices[editingIndex]?.serviceName ?? ""),
        )
      : allServiceNames;

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

  function handleDialogOpenChange(open: boolean) {
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
            const envCount = Object.keys(
              svc.containerConfig.env ?? {},
            ).length;
            const borderColor =
              svc.serviceType === "Stateful"
                ? "border-l-blue-500"
                : "border-l-green-500";

            return (
              <div
                key={svc.id}
                className={`rounded-md border border-l-4 ${borderColor} bg-card p-3`}
              >
                {/* Card header */}
                <div className="flex items-center gap-2">
                  {!readOnly && (
                    <IconGripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium text-sm">{svc.serviceName}</span>
                  {serviceTypeBadge(svc.serviceType)}
                  <span className="text-xs text-muted-foreground">
                    #{svc.order}
                  </span>
                  {svc.dependsOn.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      depends on: {svc.dependsOn.join(", ")}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {!readOnly && (
                      <>
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
                      </>
                    )}
                  </div>
                </div>

                {/* Card summary */}
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
                  {svc.routing && (
                    <span>
                      <span className="font-medium text-foreground">
                        Routing:
                      </span>{" "}
                      {svc.routing.hostname}:{svc.routing.listeningPort}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ServiceEditDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        service={dialogService}
        otherServiceNames={otherServiceNames}
        onSave={handleSave}
      />
    </div>
  );
}
