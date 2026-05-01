import { useNavigate, useOutletContext } from "react-router-dom";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { IconLoader2 } from "@tabler/icons-react";
import { useUpdateApplication } from "@/hooks/use-applications";
import { Button } from "@/components/ui/button";
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
import type { StackServiceType } from "@mini-infra/types";
import {
  editApplicationFormSchema,
  editApplicationDefaults,
  type EditApplicationFormData,
} from "@/lib/application-schemas";
import { ConfigurationCard } from "../../components/configuration-card";
import { RoutingCard } from "../../components/routing-card";
import type { ApplicationDetailContext } from "../layout";

type ApplicationData = ApplicationDetailContext["template"];

function buildDefaultValues(
  application: ApplicationData,
): EditApplicationFormData {
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
    serviceType: service.serviceType as
      | "Stateful"
      | "StatelessWeb"
      | "AdoptedWeb",
    dockerImage: service.dockerImage,
    dockerTag: service.dockerTag,
    ports,
    envVars,
    volumeMounts,
    enableRouting: hasRouting,
    routing:
      hasRouting && service.routing
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

export default function ApplicationConfigurationTab() {
  const navigate = useNavigate();
  const { templateId, template, environment } =
    useOutletContext<ApplicationDetailContext>();
  const updateApplication = useUpdateApplication();
  const networkType = environment?.networkType;

  const form = useForm<EditApplicationFormData>({
    resolver: zodResolver(editApplicationFormSchema),
    defaultValues: buildDefaultValues(template),
  });

  const serviceType = useWatch({ control: form.control, name: "serviceType" });
  const enableRouting = useWatch({
    control: form.control,
    name: "enableRouting",
  });

  const onSubmit = async (formData: EditApplicationFormData) => {
    const templateName = template.name;

    const env: Record<string, string> = {};
    for (const e of formData.envVars) {
      if (e.key) env[e.key] = e.value;
    }

    const existingVersion = template.currentVersion ?? template.draftVersion;
    const existingService = existingVersion?.services?.[0];
    const existingMounts = existingService?.containerConfig?.mounts ?? [];
    const existingVolumes = existingVersion?.volumes ?? [];

    // The form only edits volume-type mounts. Preserve bind/tmpfs mounts and
    // any top-level volume declarations (e.g. volumes referenced by config
    // files) so they aren't silently wiped on save.
    const nonVolumeMounts = existingMounts.filter((m) => m.type !== "volume");
    const formVolumeNames = new Set(formData.volumeMounts.map((v) => v.name));
    const preservedExtraVolumes = existingVolumes.filter(
      (v) => !formVolumeNames.has(v.name),
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
    <div className="max-w-3xl">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
            </CardContent>
          </Card>

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

          {(serviceType === "StatelessWeb" || enableRouting) && (
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
    </div>
  );
}
