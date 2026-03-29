import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  IconArrowLeft,
  IconLoader2,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useCreateApplication } from "@/hooks/use-applications";
import { useEnvironments } from "@/hooks/use-environments";
import { useDetectImagePorts } from "@/hooks/use-detect-image-ports";
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

// ---- Zod Schema ----

const envVarSchema = z.object({
  key: z.string().min(1, "Key is required"),
  value: z.string(),
});

const portMappingSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]),
});

const volumeMountSchema = z.object({
  name: z.string().min(1, "Volume name is required"),
  mountPath: z.string().min(1, "Mount path is required"),
});

const healthCheckSchema = z.object({
  test: z.string().min(1, "Health check command is required"),
  interval: z.number().int().min(1, "Must be at least 1s"),
  timeout: z.number().int().min(1, "Must be at least 1s"),
  retries: z.number().int().min(1).max(20),
  startPeriod: z.number().int().min(0),
});

const routingSchema = z.object({
  hostname: z.string().min(1, "Hostname is required"),
  listeningPort: z.number().int().min(1).max(65535),
  enableSsl: z.boolean().optional(),
  enableTunnel: z.boolean().optional(),
});

const applicationFormSchema = z.object({
  displayName: z.string().min(1, "Application name is required").max(100),
  description: z.string().max(500).optional(),
  serviceName: z
    .string()
    .min(1, "Service name is required")
    .max(63)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
      "Must be lowercase, alphanumeric with hyphens, no leading/trailing hyphens",
    ),
  serviceType: z.enum(["Stateful", "StatelessWeb"]),
  environmentId: z.string().min(1, "Environment is required"),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerTag: z.string().min(1, "Tag is required"),
  ports: z.array(portMappingSchema),
  envVars: z.array(envVarSchema),
  volumeMounts: z.array(volumeMountSchema),
  enableRouting: z.boolean(),
  routing: routingSchema.optional(),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]),
  enableHealthCheck: z.boolean(),
  healthCheck: healthCheckSchema.optional(),
  deployImmediately: z.boolean(),
});

type ApplicationFormData = z.infer<typeof applicationFormSchema>;

const defaultValues: ApplicationFormData = {
  displayName: "",
  description: "",
  serviceName: "",
  serviceType: "Stateful",
  environmentId: "",
  dockerImage: "",
  dockerTag: "latest",
  ports: [],
  envVars: [],
  volumeMounts: [],
  enableRouting: false,
  routing: { hostname: "", listeningPort: 8080, enableSsl: false, enableTunnel: false },
  restartPolicy: "unless-stopped",
  enableHealthCheck: false,
  healthCheck: { test: "curl -f http://localhost/ || exit 1", interval: 30, timeout: 10, retries: 3, startPeriod: 15 },
  deployImmediately: true,
};

export default function NewApplicationPage() {
  const navigate = useNavigate();
  const createApplication = useCreateApplication();

  const form = useForm<ApplicationFormData>({
    resolver: zodResolver(applicationFormSchema),
    defaultValues,
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

  const setFormValue = form.setValue;

  useEffect(() => {
    if (!selectedEnvId || !serviceType) return;

    if (serviceType === "StatelessWeb") {
      setFormValue("enableRouting", true);
      if (networkType === "local") {
        setFormValue("routing.enableSsl", true);
        setFormValue("routing.enableTunnel", false);
      } else if (networkType === "internet") {
        setFormValue("routing.enableSsl", false);
        setFormValue("routing.enableTunnel", true);
      }
    } else {
      setFormValue("enableRouting", false);
    }
  }, [selectedEnvId, serviceType, networkType, setFormValue]);

  const handleDetectPorts = async () => {
    const image = form.getValues("dockerImage");
    const tag = form.getValues("dockerTag");
    if (!image || !tag) return;

    try {
      const ports = await detectPorts.mutateAsync({ image, tag });
      setDetectedPorts(ports);
      setUseCustomPort(false);
      if (ports.length >= 1) {
        form.setValue("routing.listeningPort", ports[0]);
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

  const onSubmit = async (data: ApplicationFormData) => {
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

    // Build routing
    const routing =
      data.enableRouting && data.routing
        ? {
            hostname: data.routing.hostname,
            listeningPort: data.routing.listeningPort,
            ...(data.routing.enableSsl ? { tlsCertificate: data.routing.hostname } : {}),
            ...(data.routing.enableTunnel ? { tunnelIngress: data.routing.hostname } : {}),
          }
        : undefined;

    // Build networks - add a default network for the service
    const networks = [{ name: `${templateName}-net` }];

    try {
      await createApplication.mutateAsync({
        name: templateName,
        displayName: data.displayName,
        description: data.description || undefined,
        scope: "environment",
        environmentId: data.environmentId,
        deployImmediately: data.deployImmediately,
        networks,
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
              joinNetworks: [`${templateName}-net`],
              restartPolicy: data.restartPolicy,
              healthcheck,
            },
            dependsOn: [],
            order: 0,
            routing,
          },
        ],
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
                    <FormItem>
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
                    <FormItem>
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
                          <FormItem>
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

                      {networkType === "local" && (
                        <FormField
                          control={form.control}
                          name="routing.enableSsl"
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-3">
                              <FormControl>
                                <Switch
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <FormLabel className="!mt-0">Enable SSL</FormLabel>
                            </FormItem>
                          )}
                        />
                      )}

                      {networkType === "internet" && (
                        <FormField
                          control={form.control}
                          name="routing.enableTunnel"
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-3">
                              <FormControl>
                                <Switch
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <FormLabel className="!mt-0">Enable Cloudflare Tunnel</FormLabel>
                            </FormItem>
                          )}
                        />
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
                    disabled={createApplication.isPending}
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
