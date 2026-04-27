import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { StackServiceDefinition } from "@mini-infra/types";
import {
  emptyFormValues,
  formValuesToService,
  serviceFormSchema,
  serviceToFormValues,
  type ServiceFormValues,
} from "./service-form-schema";
import {
  GeneralTab,
  EnvTab,
  PortsTab,
  MountsTab,
  NetworksTab,
  HealthcheckTab,
  LoggingTab,
  LabelsTab,
  RoutingTab,
  InitCommandsTab,
} from "./service-form-tabs";

type TabKey =
  | "general"
  | "env"
  | "ports"
  | "mounts"
  | "networks"
  | "healthcheck"
  | "logging"
  | "labels"
  | "routing"
  | "init";

const TABS: { key: TabKey; label: string }[] = [
  { key: "general", label: "General" },
  { key: "env", label: "Environment" },
  { key: "ports", label: "Ports" },
  { key: "mounts", label: "Mounts" },
  { key: "networks", label: "Networks" },
  { key: "healthcheck", label: "Healthcheck" },
  { key: "logging", label: "Logging" },
  { key: "labels", label: "Labels" },
  { key: "routing", label: "Routing" },
  { key: "init", label: "Init Commands" },
];

interface ServiceEditDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: StackServiceDefinition | null;
  onSave: (service: StackServiceDefinition) => void;
}

export function ServiceEditDrawer({
  open,
  onOpenChange,
  service,
  onSave,
}: ServiceEditDrawerProps) {
  const isEditing = service !== null;
  const [activeTab, setActiveTab] = useState<TabKey>("general");

  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceFormSchema) as Resolver<
      z.infer<typeof serviceFormSchema>
    >,
    defaultValues: emptyFormValues,
  });

  const serviceType = useWatch({ control: form.control, name: "serviceType" });

  // Reset form + tab whenever the drawer opens or the service changes while
  // open. Routed through a ref so setActiveTab sits outside the reactive
  // body of the effect.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    const switchedWhileOpen = open && prevOpenRef.current;
    prevOpenRef.current = open;
    if (justOpened || switchedWhileOpen) {
      form.reset(service ? serviceToFormValues(service) : emptyFormValues);
      if (justOpened) setActiveTab("general");
    }
  }, [open, service, form]);

  function onSubmit(values: ServiceFormValues) {
    try {
      const definition = formValuesToService(values);
      onSave(definition);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid service config");
    }
  }

  // Show an error indicator on tabs whose fields have validation errors.
  const errors = form.formState.errors;
  const tabHasError = (key: TabKey): boolean => {
    const fieldsByTab: Record<TabKey, (keyof ServiceFormValues)[]> = {
      general: [
        "serviceName",
        "serviceType",
        "dockerImage",
        "dockerTag",
        "order",
        "dependsOn",
        "user",
        "command",
        "entrypoint",
        "restartPolicy",
        "adoptedContainerName",
        "adoptedListeningPort",
      ],
      env: ["envVars"],
      ports: ["ports"],
      mounts: ["mounts"],
      networks: ["joinNetworks", "joinResourceNetworks"],
      healthcheck: [
        "healthcheckEnabled",
        "healthcheckTest",
        "healthcheckInterval",
        "healthcheckTimeout",
        "healthcheckRetries",
        "healthcheckStartPeriod",
      ],
      logging: ["loggingEnabled", "logType", "logMaxSize", "logMaxFile"],
      labels: ["labels"],
      routing: [
        "routingHostname",
        "routingListeningPort",
        "routingHealthCheckEndpoint",
        "routingTlsCertificate",
        "routingDnsRecord",
        "routingTunnelIngress",
        "routingBalanceAlgorithm",
        "routingCheckTimeout",
        "routingConnectTimeout",
        "routingServerTimeout",
      ],
      init: ["initCommands"],
    };
    return fieldsByTab[key].some((f) => Boolean(errors[f]));
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-3xl flex flex-col p-0"
      >
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>
            {isEditing ? `Edit ${service?.serviceName}` : "Add Service"}
          </SheetTitle>
          <SheetDescription>
            Configure how this service runs, is routed to, and depends on others.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-1 min-h-0 flex-col"
          >
            <div className="flex flex-1 min-h-0">
              {/* Vertical tab nav */}
              <nav className="w-44 shrink-0 border-r bg-muted/20 overflow-y-auto">
                <ul className="flex flex-col py-2">
                  {TABS.map((t) => {
                    const isActive = t.key === activeTab;
                    const hasErr = tabHasError(t.key);
                    return (
                      <li key={t.key}>
                        <button
                          type="button"
                          onClick={() => setActiveTab(t.key)}
                          className={cn(
                            "w-full text-left px-4 py-2 text-sm transition-colors",
                            isActive
                              ? "bg-background font-medium border-l-2 border-primary"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground border-l-2 border-transparent",
                          )}
                        >
                          <span className="flex items-center justify-between">
                            {t.label}
                            {hasErr && (
                              <span className="h-2 w-2 rounded-full bg-destructive" />
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </nav>

              {/* Tab content */}
              <div className="flex-1 min-w-0 overflow-y-auto p-6">
                {activeTab === "general" && (
                  <GeneralTab
                    control={form.control}
                    isEditing={isEditing}
                    serviceType={serviceType}
                  />
                )}
                {activeTab === "env" && <EnvTab control={form.control} />}
                {activeTab === "ports" && <PortsTab control={form.control} />}
                {activeTab === "mounts" && <MountsTab control={form.control} />}
                {activeTab === "networks" && <NetworksTab control={form.control} />}
                {activeTab === "healthcheck" && (
                  <HealthcheckTab control={form.control} />
                )}
                {activeTab === "logging" && <LoggingTab control={form.control} />}
                {activeTab === "labels" && <LabelsTab control={form.control} />}
                {activeTab === "routing" && (
                  <RoutingTab
                    control={form.control}
                    serviceType={serviceType}
                  />
                )}
                {activeTab === "init" && <InitCommandsTab control={form.control} />}
              </div>
            </div>

            <SheetFooter className="flex-row justify-end border-t px-6 py-4 gap-2 mt-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isEditing ? "Save Changes" : "Add Service"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
