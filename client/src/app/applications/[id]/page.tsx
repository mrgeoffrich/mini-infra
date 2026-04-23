import { useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  IconArrowLeft,
  IconLoader2,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { StackServiceType } from "@mini-infra/types";
import {
  editApplicationFormSchema,
  editApplicationDefaults,
  type EditApplicationFormData,
} from "@/lib/application-schemas";
import { ConfigurationCard } from "../components/configuration-card";
import { RoutingCard } from "../components/routing-card";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ApplicationData = NonNullable<
  ReturnType<typeof useApplication>["data"]
>["data"];

function buildDefaultValues(application: ApplicationData): EditApplicationFormData {
  const version = application.currentVersion ?? application.draftVersion;
  const service = version?.services?.[0];

  if (!service) return editApplicationDefaults;

  const env = service.containerConfig?.env ?? {};
  const envVars = Object.entries(env).map(([key, value]) => ({
    key,
    value: value ?? "",
  }));

  // Applications only use literal integer ports; template references like
  // "{{params.port}}" are a stack-template feature not exposed here.
  const ports = (service.containerConfig?.ports ?? []).map((p) => ({
    containerPort: Number(p.containerPort),
    hostPort: Number(p.hostPort),
    protocol: p.protocol as "tcp" | "udp",
  }));

  const volumeMounts = (service.containerConfig?.mounts ?? [])
    .filter((m) => m.type === "volume")
    .map((m) => ({ name: m.source, mountPath: m.target }));

  const hasRouting = !!service.routing;
  const hc = service.containerConfig?.healthcheck;

  return {
    displayName: application.displayName,
    description: application.description ?? "",
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
          listeningPort: Number(service.routing.listeningPort),
        }
      : undefined,
    restartPolicy:
      (service.containerConfig?.restartPolicy as
        | "no"
        | "always"
        | "unless-stopped"
        | "on-failure") ?? "unless-stopped",
    enableHealthCheck: !!hc,
    healthCheck: hc
      ? {
          test: Array.isArray(hc.test) ? hc.test.slice(1).join(" ") : hc.test,
          interval: Math.round(Number(hc.interval ?? 30000) / 1000),
          timeout: Math.round(Number(hc.timeout ?? 10000) / 1000),
          retries: Number(hc.retries ?? 3),
          startPeriod: Math.round(Number(hc.startPeriod ?? 15000) / 1000),
        }
      : editApplicationDefaults.healthCheck,
  };
}

// ---------------------------------------------------------------------------
// Inner form component — only mounts after data is loaded
// ---------------------------------------------------------------------------

interface FormProps {
  templateId: string;
  application: ApplicationData;
  networkType?: "local" | "internet";
  boundEnvironmentName?: string;
}

function ApplicationEditForm({
  templateId,
  application,
  networkType,
  boundEnvironmentName,
}: FormProps) {
  const navigate = useNavigate();
  const updateApplication = useUpdateApplication();

  const form = useForm<EditApplicationFormData>({
    resolver: zodResolver(editApplicationFormSchema),
    defaultValues: buildDefaultValues(application),
  });

  const serviceType = form.watch("serviceType");

  const onSubmit = async (formData: EditApplicationFormData) => {
    const templateName = application.name;

    const env: Record<string, string> = {};
    for (const e of formData.envVars) {
      if (e.key) env[e.key] = e.value;
    }

    const existingVersion = application.currentVersion ?? application.draftVersion;
    const existingService = existingVersion?.services?.[0];
    const existingMounts = existingService?.containerConfig?.mounts ?? [];
    const existingVolumes = existingVersion?.volumes ?? [];

    // The form only edits volume-type mounts. Preserve bind/tmpfs mounts and
    // any top-level volume declarations (e.g. volumes referenced by config
    // files) so they aren't silently wiped on save.
    const nonVolumeMounts = existingMounts.filter((m) => m.type !== "volume");
    const formVolumeNames = new Set(formData.volumeMounts.map((v) => v.name));
    const preservedExtraVolumes = existingVolumes.filter(
      (v) => !formVolumeNames.has(v.name)
    );

    const volumes = [
      ...formData.volumeMounts.map((v) => ({ name: v.name })),
      ...preservedExtraVolumes,
    ];
    const mounts = [
      ...formData.volumeMounts.map((v) => ({
        source: v.name,
        target: v.mountPath,
        type: "volume" as const,
      })),
      ...nonVolumeMounts,
    ];

    const ports = formData.ports.map((p) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol,
    }));

    const healthcheck =
      formData.enableHealthCheck && formData.healthCheck
        ? {
            test: ["CMD-SHELL", formData.healthCheck.test],
            interval: formData.healthCheck.interval * 1000,
            timeout: formData.healthCheck.timeout * 1000,
            retries: formData.healthCheck.retries,
            startPeriod: formData.healthCheck.startPeriod * 1000,
          }
        : undefined;

    const routing =
      formData.enableRouting && formData.routing
        ? {
            hostname: formData.routing.hostname,
            listeningPort: formData.routing.listeningPort,
            ...(networkType === "local"
              ? {
                  tlsCertificate: formData.routing.hostname,
                  dnsRecord: formData.routing.hostname,
                }
              : {}),
            ...(networkType === "internet"
              ? { tunnelIngress: formData.routing.hostname }
              : {}),
          }
        : undefined;

    const networks =
      existingVersion?.networks && existingVersion.networks.length > 0
        ? existingVersion.networks
        : [{ name: `${templateName}-net` }];

    try {
      await updateApplication.mutateAsync({
        templateId,
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
                healthcheck,
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

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                    <Textarea placeholder="Optional description..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {boundEnvironmentName && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Environment</label>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{boundEnvironmentName}</Badge>
                  <span className="text-xs text-muted-foreground">
                    ({networkType})
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
                  <Select onValueChange={field.onChange} value={field.value}>
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
          </CardContent>
        </Card>

        <ConfigurationCard />

        {(serviceType === "StatelessWeb" || form.watch("enableRouting")) && (
          <RoutingCard networkType={networkType} showEnableToggle />
        )}

        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/applications")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateApplication.isPending}>
            {updateApplication.isPending && (
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Save Changes
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Page — handles loading / error states, then mounts form once data is ready
// ---------------------------------------------------------------------------

export default function ApplicationDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useApplication(id ?? "");
  const { data: envData } = useEnvironments();
  const environments = envData?.environments ?? [];

  const application = data?.data;
  const boundEnvironment = environments.find(
    (e) => e.id === application?.environmentId,
  );

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

  if (!application || !id) return null;

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
          <span className="font-medium">{application.displayName}</span>.
        </p>
      </div>

      <div className="px-4 lg:px-6 max-w-3xl">
        <ApplicationEditForm
          templateId={id}
          application={application}
          networkType={boundEnvironment?.networkType}
          boundEnvironmentName={boundEnvironment?.name}
        />
      </div>
    </div>
  );
}
