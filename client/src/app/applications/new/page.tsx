import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { IconArrowLeft, IconLoader2 } from "@tabler/icons-react";
import {
  useCreateApplication,
  useUserStacks,
} from "@/hooks/use-applications";
import { useEnvironments } from "@/hooks/use-environments";
import { useStacks } from "@/hooks/use-stacks";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import type { StackResourceOutput, StackServiceType } from "@mini-infra/types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import {
  createApplicationFormSchema,
  createApplicationDefaults,
  type CreateApplicationFormData,
} from "@/lib/application-schemas";

import { BasicsStep } from "./components/basics-step";
import { ServiceTypeStep } from "./components/service-type-step";
import { ImageStep } from "./components/image-step";
import { ConfigurationStep } from "./components/configuration-step";
import { RoutingStep } from "./components/routing-step";

export default function NewApplicationPage() {
  const navigate = useNavigate();
  const createApplication = useCreateApplication();
  const { registerTask } = useTaskTracker();

  const form = useForm<CreateApplicationFormData>({
    resolver: zodResolver(createApplicationFormSchema),
    defaultValues: createApplicationDefaults,
  });

  const { data: envData, isLoading: environmentsLoading } = useEnvironments();
  const environments = envData?.environments ?? [];

  const [imageValidated, setImageValidated] = useState(false);
  const [detectedPorts, setDetectedPorts] = useState<number[]>([]);

  const selectedEnvId = form.watch("environmentId");
  const displayName = form.watch("displayName");
  const serviceType = form.watch("serviceType");
  const deployImmediately = form.watch("deployImmediately");

  const selectedEnvironment = environments.find((e) => e.id === selectedEnvId);
  const networkType = selectedEnvironment?.networkType;

  const { data: stacksData } = useStacks(selectedEnvId);
  const { data: userStacksData } = useUserStacks();
  const hasHaproxyApplicationsNetwork = (stacksData?.data ?? []).some(
    (stack) =>
      stack.status === "synced" &&
      (stack.resourceOutputs as StackResourceOutput[] | undefined)?.some(
        (o) => o.type === "docker-network" && o.purpose === "applications",
      ),
  );

  const showHaproxyWarning =
    serviceType === "StatelessWeb" &&
    !!selectedEnvId &&
    !hasHaproxyApplicationsNetwork;

  // Progression gates
  const hasBasics =
    Boolean(selectedEnvId) && displayName.trim().length > 0;
  const hasServiceType =
    hasBasics &&
    Boolean(serviceType) &&
    (serviceType !== "StatelessWeb" || hasHaproxyApplicationsNetwork);
  const canShowConfig = hasServiceType && imageValidated;
  const canShowRouting = canShowConfig && serviceType === "StatelessWeb";
  const canShowCreate =
    canShowConfig && (serviceType !== "StatelessWeb" || canShowRouting);

  const handleImageValidated = ({
    image,
    ports,
  }: {
    image: string;
    ports: number[];
  }) => {
    setImageValidated(true);
    setDetectedPorts(ports);

    // For routing: default listeningPort to the first detected port
    if (ports.length >= 1) {
      form.setValue("routing.listeningPort", ports[0], {
        shouldValidate: true,
      });
    }

    // Make sure dockerImage is set (ImageStep already does this, but belt & braces)
    form.setValue("dockerImage", image, { shouldValidate: true });
  };

  const handleImageReset = () => {
    setImageValidated(false);
    setDetectedPorts([]);
  };

  const onSubmit = async (data: CreateApplicationFormData) => {
    if (
      data.serviceType === "StatelessWeb" &&
      !hasHaproxyApplicationsNetwork
    ) {
      toast.error(
        "This environment does not have a deployed HAProxy stack with an applications network.",
      );
      return;
    }

    // Hostname uniqueness check — against existing stack service routing
    if (data.enableRouting && data.routing?.hostname) {
      const desired = data.routing.hostname.trim().toLowerCase();
      const takenBy = (userStacksData?.data ?? []).find((stack) =>
        (stack.services ?? []).some(
          (svc) =>
            svc.routing?.hostname?.trim().toLowerCase() === desired,
        ),
      );
      if (takenBy) {
        toast.error(
          `Hostname "${data.routing.hostname}" is already used by "${takenBy.name}".`,
        );
        return;
      }
    }

    const templateName = data.displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const env: Record<string, string> = {};
    for (const e of data.envVars) {
      if (e.key) env[e.key] = e.value;
    }

    const volumes = data.volumeMounts.map((v) => ({ name: v.name }));
    const mounts = data.volumeMounts.map((v) => ({
      source: v.name,
      target: v.mountPath,
      type: "volume" as const,
    }));

    const ports = data.ports.map((p) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol,
    }));

    const healthcheck =
      data.enableHealthCheck && data.healthCheck
        ? {
            test: ["CMD-SHELL", data.healthCheck.test],
            interval: data.healthCheck.interval * 1000,
            timeout: data.healthCheck.timeout * 1000,
            retries: data.healthCheck.retries,
            startPeriod: data.healthCheck.startPeriod * 1000,
          }
        : undefined;

    const routing =
      data.enableRouting && data.routing
        ? {
            hostname: data.routing.hostname,
            listeningPort: data.routing.listeningPort,
            ...(networkType === "local"
              ? {
                  tlsCertificate: data.routing.hostname,
                  dnsRecord: data.routing.hostname,
                }
              : {}),
            ...(networkType === "internet"
              ? { tunnelIngress: data.routing.hostname }
              : {}),
          }
        : undefined;

    const resourceInputs =
      data.serviceType === "StatelessWeb"
        ? [{ type: "docker-network", purpose: "applications" }]
        : undefined;

    try {
      await createApplication.mutateAsync({
        name: templateName,
        displayName: data.displayName,
        scope: "environment",
        environmentId: data.environmentId,
        deployImmediately: data.deployImmediately,
        resourceInputs,
        networks: [],
        volumes,
        services: [
          {
            serviceName: data.serviceName,
            serviceType: data.serviceType as StackServiceType,
            dockerImage: data.dockerImage,
            dockerTag: data.dockerTag,
            containerConfig: {
              env: Object.keys(env).length > 0 ? env : undefined,
              ports: ports.length > 0 ? ports : undefined,
              mounts: mounts.length > 0 ? mounts : undefined,
              restartPolicy: data.restartPolicy,
              healthcheck,
            },
            dependsOn: [],
            order: 0,
            routing,
          },
        ],
        onStackCreated: (stackId) => {
          registerTask({
            id: stackId,
            type: "stack-apply",
            label: `Deploying ${data.displayName}`,
            channel: Channel.STACKS,
          });
        },
      });
      navigate("/applications");
    } catch {
      // Error handled by mutation hook via toast
    }
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/applications")}
          className="mb-4"
        >
          <IconArrowLeft className="mr-1 h-4 w-4" />
          Back to Applications
        </Button>

        <h1 className="text-3xl font-bold">New Application</h1>
        <p className="mt-1 text-muted-foreground">
          Deploy a container as a managed application.
        </p>
      </div>

      <div className="max-w-3xl px-4 lg:px-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <BasicsStep
              environments={environments}
              isLoading={environmentsLoading}
            />

            {hasBasics && (
              <ServiceTypeStep showHaproxyWarning={showHaproxyWarning} />
            )}

            {hasServiceType && (
              <ImageStep
                onValidated={handleImageValidated}
                onReset={handleImageReset}
                validated={imageValidated}
              />
            )}

            {canShowConfig && <ConfigurationStep />}

            {canShowRouting && (
              <RoutingStep
                networkType={networkType}
                detectedPorts={detectedPorts}
              />
            )}

            {canShowCreate && (
              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="deployImmediately"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="!mt-0">
                        Deploy immediately after creation
                      </FormLabel>
                    </FormItem>
                  )}
                />

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => navigate("/applications")}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createApplication.isPending}
                    data-tour="new-app-create-button"
                  >
                    {createApplication.isPending && (
                      <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {deployImmediately ? "Create & Deploy" : "Create Application"}
                  </Button>
                </div>
              </div>
            )}
          </form>
        </Form>
      </div>
    </div>
  );
}
