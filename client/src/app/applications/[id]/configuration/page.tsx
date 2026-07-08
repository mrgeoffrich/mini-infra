import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { useForm, useFormContext, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { IconLoader2 } from "@tabler/icons-react";
import { useUpdateApplication } from "@/hooks/use-applications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
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
import { Switch } from "@/components/ui/switch";
import type {
  DraftVersionInput,
  StackServiceDefinition,
  StackServiceType,
} from "@mini-infra/types";
import {
  editApplicationFormSchema,
  editApplicationDefaults,
  applicationsNetworkDeclaration,
  type EditApplicationFormData,
} from "@/lib/application-schemas";
import {
  EnvVarsSection,
  HealthCheckSection,
  PortsSection,
  RestartPolicySection,
  VolumesSection,
} from "../../components/config-sections";
import { RoutingSection } from "../../components/routing-section";
import { buildDraftFromVersion } from "@/lib/application-draft";
import type { ApplicationDetailContext } from "../layout";
import { useConfigNav } from "../config-nav";
import {
  EDIT_SECTIONS,
  computeSectionErrors,
  firstErroredSectionId,
  sectionAnchorId,
} from "./section-meta";
import { useActiveSection } from "./use-active-section";

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

/** Image + tag — the most frequently edited fields, so they lead the form. */
function ImageFields() {
  const form = useFormContext<EditApplicationFormData>();
  return (
    <div className="grid grid-cols-2 gap-4">
      <FormField
        control={form.control}
        name="dockerImage"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Docker image</FormLabel>
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
            <FormDescription>Bump this to deploy a new version.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

/** Service type select — resets routing so a leftover flag can't smuggle a
 *  routing config onto a Stateful service (mirrors the create wizard). */
function ServiceTypeField() {
  const form = useFormContext<EditApplicationFormData>();
  return (
    <FormField
      control={form.control}
      name="serviceType"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Service type</FormLabel>
          <Select
            onValueChange={(value) => {
              field.onChange(value);
              form.setValue("enableRouting", value === "StatelessWeb", {
                shouldValidate: true,
              });
            }}
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
          <FormDescription>
            Stateless Web enables zero-downtime blue-green deploys via HAProxy.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Name, description, and container-name prefix — identity, rarely changed. */
function IdentityFields() {
  const form = useFormContext<EditApplicationFormData>();
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="displayName"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Application name</FormLabel>
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
      <FormField
        control={form.control}
        name="serviceName"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Service name</FormLabel>
            <FormControl>
              <Input placeholder="my-service" {...field} />
            </FormControl>
            <FormDescription>Used as the container name prefix.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

/** Card wrapper that anchors a section so the rail can scroll to it. */
function SectionCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={sectionAnchorId(id)} data-section-id={id} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const SECTION_IDS = EDIT_SECTIONS.map((s) => s.id);

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
  const envVars = useWatch({ control: form.control, name: "envVars" });
  const volumeMounts = useWatch({ control: form.control, name: "volumeMounts" });

  const showRouting = serviceType === "StatelessWeb" || enableRouting;

  const { setState: setConfigNav } = useConfigNav();
  const activeId = useActiveSection(SECTION_IDS);

  // Memoise the published values so the effect below only fires on real
  // changes — an unmemoised Set/object would be a fresh reference every render
  // and loop against the provider it updates.
  const errorKey = Object.keys(form.formState.errors).sort().join(",");
  const erroredIds = useMemo(
    () => computeSectionErrors(errorKey ? errorKey.split(",") : []),
    [errorKey],
  );
  const envCount = envVars?.length ?? 0;
  const volCount = volumeMounts?.length ?? 0;
  const badges = useMemo<Record<string, number | undefined>>(
    () => ({ environment: envCount, storage: volCount }),
    [envCount, volCount],
  );

  const scrollToSection = useCallback((id: string) => {
    document
      .getElementById(sectionAnchorId(id))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Publish this page's live section state to the shared page nav (rendered by
  // the detail layout) so it can show the Configuration sub-sections with the
  // same active highlight, error dots, and badges.
  useEffect(() => {
    setConfigNav({
      activeId,
      erroredIds,
      badges,
      onNavigate: scrollToSection,
    });
  }, [activeId, erroredIds, badges, scrollToSection, setConfigNav]);
  useEffect(() => () => setConfigNav(null), [setConfigNav]);

  const onInvalid = useCallback(() => {
    const firstId = firstErroredSectionId(Object.keys(form.formState.errors));
    if (firstId) scrollToSection(firstId);
  }, [form, scrollToSection]);

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

    // Network membership is authored on the Overview tab's Connected Networks
    // card (which edits `joinNetworks` directly). A config save must NOT touch
    // that set — preserve whatever the persisted service already declares,
    // unioned with the app's own stack network(s), so saving unrelated config
    // never drops a network added there.
    const existingJoinNetworks =
      existingService?.containerConfig?.joinNetworks ?? [];
    const joinNetworks = Array.from(
      new Set([...networks.map((n) => n.name), ...existingJoinNetworks]),
    );

    // HAProxy-routed services (StatelessWeb) must re-declare membership of the
    // environment's `applications` network on every save — otherwise editing an
    // app would drop the resource input the create flow set. The server also
    // enforces this at apply time; declaring it keeps the draft self-describing.
    const { resourceInputs, joinResourceNetworks } = applicationsNetworkDeclaration(
      formData.serviceType as StackServiceType,
    );

    // Rebuild the draft LOSSLESSLY from the existing version (mirroring the
    // Connected Networks card's `persistJoinNetworks`) so fields this form
    // doesn't model survive the save: a service's `addons` block,
    // `vault`/`nats`/`requires`, config files, parameters, etc. We overlay
    // only what the Configuration form edits — services[0] plus the
    // version-level networks/volumes/resourceInputs. Building `services` from
    // scratch here (the old behaviour) silently dropped all of the above.
    const baseDraft = existingVersion
      ? buildDraftFromVersion(existingVersion)
      : undefined;
    // Applications are single-service (services[0]); if a version somehow
    // carries more than one service, the extras are preserved untouched — the
    // form only edits the first.
    const baseService = baseDraft?.services[0];

    const editedService: StackServiceDefinition = {
      ...baseService,
      serviceName: formData.serviceName,
      serviceType: formData.serviceType as StackServiceType,
      dockerImage: formData.dockerImage,
      dockerTag: formData.dockerTag,
      containerConfig: {
        // Preserve container-config fields the form doesn't model (command,
        // entrypoint, capAdd, devices, user, labels, dynamicEnv, networkMode,
        // ...) — several are authored by addons — and override only the ones
        // it edits.
        ...baseService?.containerConfig,
        env: Object.keys(env).length > 0 ? env : undefined,
        ports: ports.length > 0 ? ports : undefined,
        mounts: mounts.length > 0 ? mounts : undefined,
        joinNetworks,
        joinResourceNetworks,
        restartPolicy: formData.restartPolicy,
        healthcheck,
      },
      dependsOn: baseService?.dependsOn ?? [],
      order: baseService?.order ?? 0,
      routing,
    };

    const draft: DraftVersionInput = baseDraft
      ? {
          ...baseDraft,
          networks,
          resourceInputs,
          volumes,
          services: [editedService, ...baseDraft.services.slice(1)],
        }
      : {
          networks,
          resourceInputs,
          volumes,
          services: [editedService],
        };

    try {
      await updateApplication.mutateAsync({
        templateId,
        metadata: {
          displayName: formData.displayName,
          description: formData.description || undefined,
        },
        draft,
      });
      navigate("/applications");
    } catch {
      // Error handled by the mutation hook via toast
    }
  };

  return (
    <div className="max-w-3xl">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit, onInvalid)}>
          <div className="bg-background sticky top-0 z-10 mb-4 flex items-center justify-between gap-3 py-2">
            <h2 className="text-lg font-medium">Configuration</h2>
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
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save changes
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <SectionCard id="image" title="Image & version">
              <ImageFields />
            </SectionCard>

            <SectionCard id="environment" title="Environment variables">
              <EnvVarsSection />
            </SectionCard>

            <SectionCard id="networking" title="Networking">
              <div className="space-y-4">
                {showRouting && (
                  <>
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
                          <FormLabel className="!mt-0">
                            Enable public routing
                          </FormLabel>
                        </FormItem>
                      )}
                    />
                    {enableRouting && <RoutingSection networkType={networkType} />}
                    <Separator />
                  </>
                )}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Host port mappings</p>
                  <PortsSection />
                </div>
              </div>
            </SectionCard>

            <SectionCard id="storage" title="Storage">
              <VolumesSection />
            </SectionCard>

            <SectionCard id="runtime" title="Runtime & advanced">
              <div className="space-y-6">
                <ServiceTypeField />
                <RestartPolicySection />
                <HealthCheckSection />
              </div>
            </SectionCard>

            <SectionCard id="identity" title="Identity">
              <IdentityFields />
            </SectionCard>
          </div>
        </form>
      </Form>
    </div>
  );
}
