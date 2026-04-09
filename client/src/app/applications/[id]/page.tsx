import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  IconArrowLeft,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconAlertCircle,
} from "@tabler/icons-react";
import { useApplication, useUpdateApplication } from "@/hooks/use-applications";
import { useEnvironments } from "@/hooks/use-environments";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { StackServiceType } from "@mini-infra/types";
import {
  editApplicationFormSchema,
  type EditApplicationFormData,
} from "@/lib/application-schemas";

export default function ApplicationDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useApplication(id ?? "");
  const updateApplication = useUpdateApplication();
  const { data: envData } = useEnvironments();
  const environments = envData?.environments ?? [];

  const application = data?.data;
  const boundEnvironmentId = application?.environmentId;
  const boundEnvironment = environments.find((e) => e.id === boundEnvironmentId);
  const networkType = boundEnvironment?.networkType;

  const form = useForm<EditApplicationFormData>({
    resolver: zodResolver(editApplicationFormSchema),
    defaultValues: {
      displayName: "",
      description: "",
      serviceName: "",
      serviceType: "Stateful",
      dockerImage: "",
      dockerTag: "latest",
      ports: [],
      envVars: [],
      volumeMounts: [],
      enableRouting: false,
      routing: undefined,
      restartPolicy: "unless-stopped",
    },
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

  const serviceType = form.watch("serviceType");
  const enableRouting = form.watch("enableRouting");

  // Load existing data into form
  useEffect(() => {
    if (!data?.data) return;
    const template = data.data;
    const version = template.currentVersion ?? template.draftVersion;
    if (!version) return;

    const service = version.services?.[0];
    if (!service) return;

    const env = service.containerConfig?.env ?? {};
    const envVars = Object.entries(env).map(([key, value]) => ({
      key,
      value: value ?? "",
    }));

    const ports = (service.containerConfig?.ports ?? []).map((p) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol as "tcp" | "udp",
    }));

    const volumeMounts = (service.containerConfig?.mounts ?? [])
      .filter((m) => m.type === "volume")
      .map((m) => ({
        name: m.source,
        mountPath: m.target,
      }));

    const hasRouting = !!service.routing;

    form.reset({
      displayName: template.displayName,
      description: template.description ?? "",
      serviceName: service.serviceName,
      serviceType: service.serviceType as "Stateful" | "StatelessWeb" | "AdoptedWeb",
      dockerImage: service.dockerImage,
      dockerTag: service.dockerTag,
      ports,
      envVars,
      volumeMounts,
      enableRouting: hasRouting,
      routing: hasRouting && service.routing
        ? {
            hostname: service.routing.hostname,
            listeningPort: service.routing.listeningPort,
            enableSsl: !!service.routing.tlsCertificate,
            enableTunnel: !!service.routing.tunnelIngress,
          }
        : undefined,
      restartPolicy:
        (service.containerConfig?.restartPolicy as
          | "no"
          | "always"
          | "unless-stopped"
          | "on-failure") ?? "unless-stopped",
    });
  }, [data, form]);

  const onSubmit = async (formData: EditApplicationFormData) => {
    if (!id || !data?.data) return;

    const template = data.data;
    const templateName = template.name;

    // Build env vars as Record
    const env: Record<string, string> = {};
    for (const e of formData.envVars) {
      if (e.key) env[e.key] = e.value;
    }

    // Build volumes and mounts
    const volumes = formData.volumeMounts.map((v) => ({ name: v.name }));
    const mounts = formData.volumeMounts.map((v) => ({
      source: v.name,
      target: v.mountPath,
      type: "volume" as const,
    }));

    // Build ports
    const ports = formData.ports.map((p) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol,
    }));

    // Build routing
    const routing =
      formData.enableRouting && formData.routing
        ? {
            hostname: formData.routing.hostname,
            listeningPort: formData.routing.listeningPort,
            ...(formData.routing.enableSsl ? { tlsCertificate: formData.routing.hostname } : {}),
            ...(formData.routing.enableTunnel ? { tunnelIngress: formData.routing.hostname } : {}),
          }
        : undefined;

    // Preserve existing networks or use default
    const existingVersion =
      template.currentVersion ?? template.draftVersion;
    const networks =
      existingVersion?.networks && existingVersion.networks.length > 0
        ? existingVersion.networks
        : [{ name: `${templateName}-net` }];

    try {
      await updateApplication.mutateAsync({
        templateId: id,
        metadata: {
          displayName: formData.displayName,
          description: formData.description || undefined,
        },
        draft: {
          networks,
          volumes,
          services: [
            {
              serviceName: formData.serviceName,
              serviceType: formData.serviceType as StackServiceType,
              dockerImage: formData.dockerImage,
              dockerTag: formData.dockerTag,
              containerConfig: {
                env: Object.keys(env).length > 0 ? env : undefined,
                ports: ports.length > 0 ? ports : undefined,
                mounts: mounts.length > 0 ? mounts : undefined,
                joinNetworks: networks.map((n) => n.name),
                restartPolicy: formData.restartPolicy,
              },
              dependsOn: [],
              order: 0,
              routing,
            },
          ],
        },
      });
      navigate("/applications");
    } catch {
      // Error handled by the mutation hook via toast
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-10 w-80" />
          <Skeleton className="h-5 w-96 mt-2" />
        </div>
        <div className="px-4 lg:px-6 max-w-3xl space-y-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
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

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load application. {error.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

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

        <h1 className="text-3xl font-bold">Edit Application</h1>
        <p className="text-muted-foreground mt-1">
          Update the configuration for{" "}
          <span className="font-medium">{data?.data?.displayName}</span>.
        </p>
      </div>

      <div className="px-4 lg:px-6 max-w-3xl">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Basic Info */}
            <Card>
              <CardHeader>
                <CardTitle>Basic Information</CardTitle>
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

                {boundEnvironment && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Environment</label>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{boundEnvironment.name}</Badge>
                      <span className="text-xs text-muted-foreground">
                        ({boundEnvironment.networkType})
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Service Configuration */}
            <Card>
              <CardHeader>
                <CardTitle>Service Configuration</CardTitle>
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
                        Used as the container name prefix.
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
                        value={field.value}
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

                <FormField
                  control={form.control}
                  name="restartPolicy"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Restart Policy</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
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

            {/* Port Mappings */}
            <Card>
              <CardHeader>
                <CardTitle>Port Mappings</CardTitle>
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
                            value={field.value}
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

            {/* Routing */}
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
                disabled={updateApplication.isPending}
              >
                {updateApplication.isPending && (
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Save Changes
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
