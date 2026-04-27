import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconLoader2,
  IconPlugConnected,
} from "@tabler/icons-react";
import { useCreateApplication } from "@/hooks/use-applications";
import { useEnvironments } from "@/hooks/use-environments";
import { useStacks } from "@/hooks/use-stacks";
import { useEligibleContainers } from "@/hooks/use-eligible-containers";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import type { StackResourceOutput, StackServiceType } from "@mini-infra/types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---- Zod Schema ----

const adoptFormSchema = z.object({
  displayName: z.string().min(1, "Name is required").max(100),
  description: z.string().max(500).optional(),
  environmentId: z.string().min(1, "Environment is required"),
  containerName: z.string().min(1, "Container is required"),
  listeningPort: z.number().int().min(1).max(65535),
  hostname: z.string().min(1, "Hostname is required").max(253),
  healthCheckEndpoint: z.string().max(500).optional(),
});

type AdoptFormData = z.infer<typeof adoptFormSchema>;

const defaultValues: AdoptFormData = {
  displayName: "",
  description: "",
  environmentId: "",
  containerName: "",
  listeningPort: 3000,
  hostname: "",
  healthCheckEndpoint: "/api/health",
};

export default function AdoptContainerPage() {
  const navigate = useNavigate();
  const createApplication = useCreateApplication();
  const { registerTask } = useTaskTracker();

  const form = useForm<AdoptFormData>({
    resolver: zodResolver(adoptFormSchema),
    defaultValues,
  });

  const { data: envData } = useEnvironments();
  const environments = envData?.environments ?? [];

  const selectedEnvId = useWatch({ control: form.control, name: "environmentId" });
  const selectedContainerName = useWatch({
    control: form.control,
    name: "containerName",
  });

  const selectedEnvironment = environments.find((e) => e.id === selectedEnvId);
  const networkType = selectedEnvironment?.networkType;

  // Fetch eligible containers for the selected environment
  const { data: eligibleData, isLoading: loadingContainers } =
    useEligibleContainers(selectedEnvId || undefined);
  const eligibleContainers = useMemo(
    () => eligibleData?.data ?? [],
    [eligibleData],
  );

  // Check if HAProxy stack with applications network exists
  const { data: stacksData } = useStacks(selectedEnvId || undefined);
  const hasHaproxyApplicationsNetwork = (stacksData?.data ?? []).some(
    (stack) =>
      stack.status === "synced" &&
      (stack.resourceOutputs as StackResourceOutput[] | undefined)?.some(
        (o) => o.type === "docker-network" && o.purpose === "applications",
      ),
  );
  const showHaproxyWarning = selectedEnvId && !hasHaproxyApplicationsNetwork;

  // Auto-fill listening port when container is selected
  const setFormValue = form.setValue;
  useEffect(() => {
    if (!selectedContainerName) return;
    const container = eligibleContainers.find(
      (c) => c.name === selectedContainerName,
    );
    if (container && container.ports.length > 0) {
      setFormValue("listeningPort", container.ports[0].containerPort, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }, [selectedContainerName, eligibleContainers, setFormValue]);

  // Reset container selection when environment changes
  useEffect(() => {
    setFormValue("containerName", "");
  }, [selectedEnvId, setFormValue]);

  const onSubmit = async (data: AdoptFormData) => {
    if (!hasHaproxyApplicationsNetwork) {
      toast.error(
        "This environment does not have a deployed HAProxy stack with an applications network. Deploy HAProxy first.",
      );
      return;
    }

    const templateName = data.displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Build routing — auto-derive TLS/DNS/tunnel from environment networkType
    const routing = {
      hostname: data.hostname,
      listeningPort: data.listeningPort,
      healthCheckEndpoint: data.healthCheckEndpoint || undefined,
      ...(networkType === "local"
        ? { tlsCertificate: data.hostname, dnsRecord: data.hostname }
        : {}),
      ...(networkType === "internet"
        ? { tunnelIngress: data.hostname }
        : {}),
    };

    try {
      await createApplication.mutateAsync({
        name: templateName,
        displayName: data.displayName,
        description: data.description || undefined,
        scope: "environment",
        environmentId: data.environmentId,
        deployImmediately: true,
        resourceInputs: [
          { type: "docker-network", purpose: "applications" },
        ],
        networks: [],
        volumes: [],
        services: [
          {
            serviceName: templateName,
            serviceType: "AdoptedWeb" as StackServiceType,
            dockerImage: "adopted",
            dockerTag: "n/a",
            containerConfig: {},
            dependsOn: [],
            order: 0,
            routing,
            adoptedContainer: {
              containerName: data.containerName,
              listeningPort: data.listeningPort,
            },
          },
        ],
        onStackCreated: (stackId: string) => {
          registerTask({
            id: stackId,
            type: "stack-apply",
            label: `Connecting ${data.displayName}`,
            channel: Channel.STACKS,
          });
        },
      });
      navigate("/applications");
    } catch {
      // Error handled by the mutation hook via toast
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
          <IconArrowLeft className="h-4 w-4 mr-1" />
          Back to Applications
        </Button>

        <h1 className="text-3xl font-bold">Connect Existing Container</h1>
        <p className="text-muted-foreground mt-1">
          Route traffic to an already-running Docker container via HAProxy with
          optional TLS and DNS.
        </p>
      </div>

      <div className="px-4 lg:px-6 max-w-3xl">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Basic Info */}
            <Card>
              <CardHeader>
                <CardTitle>Basic Information</CardTitle>
                <CardDescription>
                  Name this connection for easy identification.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="displayName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name</FormLabel>
                      <FormControl>
                        <Input placeholder="My App" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Optional description..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Container Selection */}
            <Card>
              <CardHeader>
                <CardTitle>Container Selection</CardTitle>
                <CardDescription>
                  Choose the environment and running container to route traffic
                  to.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="environmentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Environment</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ?? ""}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select an environment" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {environments.map((env) => (
                            <SelectItem key={env.id} value={env.id}>
                              {env.name}
                              <span className="ml-2 text-xs text-muted-foreground">
                                ({env.networkType})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {showHaproxyWarning && (
                  <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                    <IconAlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium">HAProxy stack required</p>
                      <p className="mt-1 text-destructive/80">
                        Connecting a container requires a deployed HAProxy stack
                        with an applications network in this environment. Go to
                        the environment&apos;s infrastructure stacks and deploy
                        HAProxy first.
                      </p>
                    </div>
                  </div>
                )}

                {selectedEnvId && (
                  <FormField
                    control={form.control}
                    name="containerName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Container</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? ""}
                          disabled={loadingContainers}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue
                                placeholder={
                                  loadingContainers
                                    ? "Loading containers..."
                                    : "Select a running container"
                                }
                              />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {eligibleContainers.map((c) => (
                              <SelectItem key={c.id} value={c.name}>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{c.name}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {c.image}:{c.imageTag}
                                  </span>
                                  {c.isSelf && (
                                    <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-1.5 py-0.5 rounded">
                                      this app
                                    </span>
                                  )}
                                </div>
                              </SelectItem>
                            ))}
                            {!loadingContainers &&
                              eligibleContainers.length === 0 && (
                                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                                  No eligible containers found. Make sure a
                                  container is running.
                                </div>
                              )}
                          </SelectContent>
                        </Select>
                        <FormDescription>
                          Only running containers not already managed by a stack
                          are shown.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </CardContent>
            </Card>

            {/* Routing Configuration */}
            {selectedContainerName && (
              <Card>
                <CardHeader>
                  <CardTitle>Routing</CardTitle>
                  <CardDescription>
                    Configure how traffic reaches this container via HAProxy.
                    {networkType === "local" &&
                      " TLS certificate and DNS record will be provisioned automatically."}
                    {networkType === "internet" &&
                      " Traffic will be routed through the Cloudflare tunnel."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="hostname"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Hostname</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="app.example.com"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          The domain name that will route to this container.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="listeningPort"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Container Port</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            {...field}
                            onChange={(e) =>
                              field.onChange(parseInt(e.target.value, 10) || 0)
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          The port the container listens on inside the Docker
                          network.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="healthCheckEndpoint"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Health Check Path</FormLabel>
                        <FormControl>
                          <Input placeholder="/health" {...field} />
                        </FormControl>
                        <FormDescription>
                          Optional HTTP path for HAProxy health checks.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>
            )}

            {/* Submit */}
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
                disabled={
                  createApplication.isPending || !hasHaproxyApplicationsNetwork
                }
              >
                {createApplication.isPending ? (
                  <>
                    <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <IconPlugConnected className="h-4 w-4 mr-2" />
                    Connect & Deploy
                  </>
                )}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
