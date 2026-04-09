import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconLoader2,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useCreateApplication } from "@/hooks/use-applications";
import { useEnvironments } from "@/hooks/use-environments";
import { useStacks } from "@/hooks/use-stacks";
import { useDetectImagePorts } from "@/hooks/use-detect-image-ports";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import type { StackResourceOutput } from "@mini-infra/types";
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
import { Switch } from "@/components/ui/switch";
import type { StackServiceType } from "@mini-infra/types";
import {
  createApplicationFormSchema,
  createApplicationDefaults,
  type CreateApplicationFormData,
} from "@/lib/application-schemas";

export default function NewApplicationPage() {
  const navigate = useNavigate();
  const createApplication = useCreateApplication();
  const { registerTask } = useTaskTracker();

  const form = useForm<CreateApplicationFormData>({
    resolver: zodResolver(createApplicationFormSchema),
    defaultValues: createApplicationDefaults,
  });

  const {
    fields: portFields,
    append: appendPort,
    remove: removePort,
  } = useFieldArray({ control: form.control, name: "ports" });

  const {
    fields: envFields,
    append: appendEnv,
    remove: removeEnv,
  } = useFieldArray({ control: form.control, name: "envVars" });

  const {
    fields: volumeFields,
    append: appendVolume,
    remove: removeVolume,
  } = useFieldArray({ control: form.control, name: "volumeMounts" });

  const { data: envData } = useEnvironments();
  const environments = envData?.environments ?? [];

  const detectPorts = useDetectImagePorts();
  const [detectedPorts, setDetectedPorts] = useState<number[]>([]);
  const [useCustomPort, setUseCustomPort] = useState(false);

  const selectedEnvId = form.watch("environmentId");
  const serviceType = form.watch("serviceType");
  const enableRouting = form.watch("enableRouting");
  const enableHealthCheck = form.watch("enableHealthCheck");

  const selectedEnvironment = environments.find((e) => e.id === selectedEnvId);
  const networkType = selectedEnvironment?.networkType;

  // Check if HAProxy stack with applications network exists in the selected environment
  const { data: stacksData } = useStacks(selectedEnvId);
  const hasHaproxyApplicationsNetwork = (stacksData?.data ?? []).some(
    (stack) =>
      stack.status === "synced" &&
      (stack.resourceOutputs as StackResourceOutput[] | undefined)?.some(
        (o) => o.type === "docker-network" && o.purpose === "applications",
      ),
  );
  const showHaproxyWarning =
    serviceType === "StatelessWeb" && selectedEnvId && !hasHaproxyApplicationsNetwork;

  const setFormValue = form.setValue;

  useEffect(() => {
    if (!selectedEnvId || !serviceType) return;
    setFormValue("enableRouting", serviceType === "StatelessWeb");
  }, [selectedEnvId, serviceType, setFormValue]);

  const handleDetectPorts = async () => {
    const image = form.getValues("dockerImage");
    const tag = form.getValues("dockerTag");
    if (!image || !tag) return;

    try {
      const ports = await detectPorts.mutateAsync({ image, tag });
      setDetectedPorts(ports);
      setUseCustomPort(false);
      if (ports.length >= 1) {
        form.setValue("routing.listeningPort", ports[0], { shouldDirty: true, shouldValidate: true });
      } else {
        toast.info("No exposed ports found in this image");
      }
    } catch {
      toast.error("Couldn't detect ports — you can set the port manually");
    }
  };

  const dockerImage = form.watch("dockerImage");
  const dockerTag = form.watch("dockerTag");

  useEffect(() => {
    setDetectedPorts([]);
    setUseCustomPort(false);
  }, [dockerImage, dockerTag]);

  const onSubmit = async (data: CreateApplicationFormData) => {
    // Prevent creation of StatelessWeb apps without HAProxy
    if (data.serviceType === "StatelessWeb" && !hasHaproxyApplicationsNetwork) {
      toast.error(
        "This environment does not have a deployed HAProxy stack with an applications network. Deploy an HAProxy stack first before creating a stateless web application.",
      );
      return;
    }

    // Build the template name from display name
    const templateName = data.displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Build env vars as Record
    const env: Record<string, string> = {};
    for (const e of data.envVars) {
      if (e.key) env[e.key] = e.value;
    }

    // Build volumes and mounts
    const volumes = data.volumeMounts.map((v) => ({ name: v.name }));
    const mounts = data.volumeMounts.map((v) => ({
      source: v.name,
      target: v.mountPath,
      type: "volume" as const,
    }));

    // Build ports
    const ports = data.ports.map((p) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol,
    }));

    // Build healthcheck
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

    // Build routing — auto-derive resources from environment network type
    const routing =
      data.enableRouting && data.routing
        ? {
            hostname: data.routing.hostname,
            listeningPort: data.routing.listeningPort,
            ...(networkType === "local"
              ? { tlsCertificate: data.routing.hostname, dnsRecord: data.routing.hostname }
              : {}),
            ...(networkType === "internet"
              ? { tunnelIngress: data.routing.hostname }
              : {}),
          }
        : undefined;

    // StatelessWeb apps depend on the HAProxy applications network
    const resourceInputs =
      data.serviceType === "StatelessWeb"
        ? [{ type: "docker-network", purpose: "applications" }]
        : undefined;

    try {
      await createApplication.mutateAsync({
        name: templateName,
        displayName: data.displayName,
        description: data.description || undefined,
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

        <h1 className="text-3xl font-bold">New Application</h1>
        <p className="text-muted-foreground mt-1">
          Define a new application template with its services, ports, and
          configuration.
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
                  Name and describe your application.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="displayName"
                  render={({ field }) => (
                    <FormItem data-tour="new-app-display-name-input">
                      <FormLabel>Application Name</FormLabel>
                      <FormControl>
                        <Input placeholder="My Application" {...field} />
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

            {/* Service Configuration */}
            <Card>
              <CardHeader>
                <CardTitle>Service Configuration</CardTitle>
                <CardDescription>
                  Define the Docker service for this application.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="serviceName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Service Name</FormLabel>
                      <FormControl>
                        <Input placeholder="my-service" {...field} />
                      </FormControl>
                      <FormDescription>
                        Used as the container name prefix. Lowercase, hyphens
                        allowed.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="serviceType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Service Type</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Stateful">
                            Stateful (database, cache, etc.)
                          </SelectItem>
                          <SelectItem value="StatelessWeb">
                            Stateless Web (web server, API, etc.)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="environmentId"
                  render={({ field }) => (
                    <FormItem data-tour="new-app-environment-select">
                      <FormLabel>Environment</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
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
                        Stateless web applications require a deployed HAProxy stack with an
                        applications network in this environment. Go to the environment&apos;s
                        infrastructure stacks and deploy an HAProxy load balancer first.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {serviceType && selectedEnvId && (
              <>
                {/* Docker Image & Container Config */}
                <Card>
                  <CardHeader>
                    <CardTitle>Container Configuration</CardTitle>
                    <CardDescription>
                      Configure the Docker image and container settings.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="dockerImage"
                        render={({ field }) => (
                          <FormItem data-tour="new-app-docker-image-input">
                            <FormLabel>Docker Image</FormLabel>
                            <FormControl>
                              <Input placeholder="nginx" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="dockerTag"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tag</FormLabel>
                            <FormControl>
                              <Input placeholder="latest" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!form.watch("dockerImage") || !form.watch("dockerTag") || detectPorts.isPending}
                      onClick={handleDetectPorts}
                    >
                      {detectPorts.isPending ? (
                        <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : null}
                      Detect Ports
                    </Button>

                    <FormField
                      control={form.control}
                      name="restartPolicy"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Restart Policy</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="no">No</SelectItem>
                              <SelectItem value="always">Always</SelectItem>
                              <SelectItem value="unless-stopped">
                                Unless Stopped
                              </SelectItem>
                              <SelectItem value="on-failure">On Failure</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

            {/* Health Check */}
            <Card>
              <CardHeader>
                <CardTitle>Health Check</CardTitle>
                <CardDescription>
                  Configure a Docker health check for the container.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="enableHealthCheck"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-3">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="!mt-0">Enable Health Check</FormLabel>
                    </FormItem>
                  )}
                />

                {enableHealthCheck && (
                  <>
                    <FormField
                      control={form.control}
                      name="healthCheck.test"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Command</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="curl -f http://localhost/ || exit 1"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Shell command to test container health. Should exit 0 for healthy.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="healthCheck.interval"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Interval (seconds)</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                value={field.value || ""}
                                onChange={(e) =>
                                  field.onChange(
                                    e.target.value ? Number(e.target.value) : 0,
                                  )
                                }
                              />
                            </FormControl>
                            <FormDescription>
                              Time between health checks.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="healthCheck.timeout"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Timeout (seconds)</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                value={field.value || ""}
                                onChange={(e) =>
                                  field.onChange(
                                    e.target.value ? Number(e.target.value) : 0,
                                  )
                                }
                              />
                            </FormControl>
                            <FormDescription>
                              Max time for a single check.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="healthCheck.retries"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Retries</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                value={field.value || ""}
                                onChange={(e) =>
                                  field.onChange(
                                    e.target.value ? Number(e.target.value) : 0,
                                  )
                                }
                              />
                            </FormControl>
                            <FormDescription>
                              Consecutive failures before unhealthy.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="healthCheck.startPeriod"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Start Period (seconds)</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                value={field.value ?? ""}
                                onChange={(e) =>
                                  field.onChange(
                                    e.target.value ? Number(e.target.value) : 0,
                                  )
                                }
                              />
                            </FormControl>
                            <FormDescription>
                              Grace period before checks count.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Port Mappings */}
            <Card>
              <CardHeader>
                <CardTitle>Port Mappings</CardTitle>
                <CardDescription>
                  Map container ports to host ports.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {portFields.map((field, index) => (
                  <div key={field.id} className="flex items-end gap-2">
                    <FormField
                      control={form.control}
                      name={`ports.${index}.hostPort`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          {index === 0 && <FormLabel>Host Port</FormLabel>}
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="8080"
                              value={field.value || ""}
                              onChange={(e) =>
                                field.onChange(
                                  e.target.value
                                    ? Number(e.target.value)
                                    : 0,
                                )
                              }
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`ports.${index}.containerPort`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          {index === 0 && (
                            <FormLabel>Container Port</FormLabel>
                          )}
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="80"
                              value={field.value || ""}
                              onChange={(e) =>
                                field.onChange(
                                  e.target.value
                                    ? Number(e.target.value)
                                    : 0,
                                )
                              }
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`ports.${index}.protocol`}
                      render={({ field }) => (
                        <FormItem className="w-24">
                          {index === 0 && <FormLabel>Protocol</FormLabel>}
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="tcp">TCP</SelectItem>
                              <SelectItem value="udp">UDP</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removePort(index)}
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    appendPort({
                      hostPort: 0,
                      containerPort: 0,
                      protocol: "tcp",
                    })
                  }
                >
                  <IconPlus className="h-4 w-4 mr-1" />
                  Add Port
                </Button>
              </CardContent>
            </Card>

            {/* Environment Variables */}
            <Card>
              <CardHeader>
                <CardTitle>Environment Variables</CardTitle>
                <CardDescription>
                  Set environment variables for the container.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {envFields.map((field, index) => (
                  <div key={field.id} className="flex items-end gap-2">
                    <FormField
                      control={form.control}
                      name={`envVars.${index}.key`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          {index === 0 && <FormLabel>Key</FormLabel>}
                          <FormControl>
                            <Input placeholder="ENV_VAR" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`envVars.${index}.value`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          {index === 0 && <FormLabel>Value</FormLabel>}
                          <FormControl>
                            <Input placeholder="value" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeEnv(index)}
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => appendEnv({ key: "", value: "" })}
                >
                  <IconPlus className="h-4 w-4 mr-1" />
                  Add Variable
                </Button>
              </CardContent>
            </Card>

            {/* Volumes */}
            <Card>
              <CardHeader>
                <CardTitle>Volumes</CardTitle>
                <CardDescription>
                  Mount named volumes into the container.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {volumeFields.map((field, index) => (
                  <div key={field.id} className="flex items-end gap-2">
                    <FormField
                      control={form.control}
                      name={`volumeMounts.${index}.name`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          {index === 0 && <FormLabel>Volume Name</FormLabel>}
                          <FormControl>
                            <Input placeholder="data-volume" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`volumeMounts.${index}.mountPath`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          {index === 0 && <FormLabel>Mount Path</FormLabel>}
                          <FormControl>
                            <Input placeholder="/data" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeVolume(index)}
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => appendVolume({ name: "", mountPath: "" })}
                >
                  <IconPlus className="h-4 w-4 mr-1" />
                  Add Volume
                </Button>
              </CardContent>
            </Card>

            {/* Routing (for StatelessWeb) */}
            {serviceType === "StatelessWeb" && (
              <Card>
                <CardHeader>
                  <CardTitle>Routing</CardTitle>
                  <CardDescription>
                    Configure HTTP routing via HAProxy for this web service.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="enableRouting"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-3">
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <FormLabel className="!mt-0">Enable Routing</FormLabel>
                      </FormItem>
                    )}
                  />

                  {enableRouting && (
                    <>
                      <FormField
                        control={form.control}
                        name="routing.hostname"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Hostname</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="app.example.com"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="routing.listeningPort"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Listening Port</FormLabel>
                            <FormControl>
                              {detectedPorts.length >= 2 && !useCustomPort ? (
                                <Select
                                  value={String(field.value)}
                                  onValueChange={(val) => {
                                    if (val === "custom") {
                                      setUseCustomPort(true);
                                    } else {
                                      field.onChange(Number(val));
                                    }
                                  }}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {detectedPorts.map((port) => (
                                      <SelectItem key={port} value={String(port)}>
                                        {port}
                                      </SelectItem>
                                    ))}
                                    <SelectItem value="custom">Custom...</SelectItem>
                                  </SelectContent>
                                </Select>
                              ) : (
                                <Input
                                  type="number"
                                  placeholder="80"
                                  value={field.value || ""}
                                  onChange={(e) =>
                                    field.onChange(
                                      e.target.value
                                        ? Number(e.target.value)
                                        : 0,
                                    )
                                  }
                                />
                              )}
                            </FormControl>
                            <FormDescription>
                              The port your application listens on inside the
                              container.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {networkType && (
                        <div className="text-sm text-muted-foreground p-3 bg-muted rounded-md">
                          {networkType === "local" &&
                            "A TLS certificate and DNS record will be automatically created for this hostname."}
                          {networkType === "internet" &&
                            "A Cloudflare tunnel ingress will be automatically created for this hostname."}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            )}
                {/* Deploy Immediately */}
                <FormField
                  control={form.control}
                  name="deployImmediately"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel className="!mt-0">Deploy immediately after creation</FormLabel>
                    </FormItem>
                  )}
                />

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
                    disabled={createApplication.isPending || !!showHaproxyWarning}
                    data-tour="new-app-create-button"
                  >
                    {createApplication.isPending && (
                      <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {form.watch("deployImmediately") ? "Create & Deploy" : "Create Application"}
                  </Button>
                </div>
              </>
            )}
          </form>
        </Form>
      </div>
    </div>
  );
}
