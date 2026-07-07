import { useState, useEffect, useEffectEvent, useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useSystemSettings,
  useCreateSystemSetting,
  useUpdateSystemSetting,
} from "@/hooks/use-settings";
import { useStackTemplates, useInstantiateTemplate } from "@/hooks/use-stack-templates";
import { useStackApply, useStackApplyProgress } from "@/hooks/use-stacks";
import { useTailscaleIngressStatus } from "@/hooks/use-tailscale-ingress";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { StackStatusBadge } from "@/components/stacks";
import {
  Channel,
  TAILSCALE_INGRESS_TEMPLATE_NAME,
  type StackTemplateInfo,
  type StackTemplateLinkedStack,
  type SystemSettingsInfo,
} from "@mini-infra/types";
import { toastWithCopy } from "@/lib/toast-utils";
import {
  IconAlertCircle,
  IconDeviceFloppy,
  IconLoader2,
  IconNetwork,
  IconWorld,
  IconRouter,
  IconRocket,
  IconExternalLink,
  IconCircleCheck,
} from "@tabler/icons-react";

const IPV4_REGEX =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

const networkAccessSchema = z.object({
  publicUrl: z
    .string()
    .optional()
    .refine(
      (val) => !val || /^https?:\/\//.test(val),
      "Must be a valid URL starting with http:// or https://",
    ),
  corsEnabled: z.boolean(),
  dockerHostIp: z
    .string()
    .optional()
    .refine(
      (val) => !val || IPV4_REGEX.test(val),
      "Must be a valid IPv4 address (e.g., 192.168.1.100)",
    ),
});

type NetworkAccessFormData = z.infer<typeof networkAccessSchema>;

export default function NetworkAccessPage() {
  const [isSaving, setIsSaving] = useState(false);
  // Non-null while a Public-URL change that could lock the operator out of CORS
  // is awaiting confirmation.
  const [pendingSubmit, setPendingSubmit] = useState<NetworkAccessFormData | null>(null);
  const [ingressStackId, setIngressStackId] = useState<string | null>(null);

  // ---- Reachability settings (relocated from System Settings) ----
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings,
  } = useSystemSettings({
    filters: { category: "system", isActive: true },
    limit: 50,
  });
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  const form = useForm<NetworkAccessFormData>({
    resolver: zodResolver(networkAccessSchema),
    defaultValues: { publicUrl: "", corsEnabled: false, dockerHostIp: "" },
    mode: "onChange",
  });

  const settings = useMemo<Record<string, SystemSettingsInfo>>(() => {
    if (!settingsData?.data) return {};
    return settingsData.data.reduce(
      (acc, setting) => {
        acc[setting.key] = setting;
        return acc;
      },
      {} as Record<string, SystemSettingsInfo>,
    );
  }, [settingsData]);

  const syncFormFromSettings = useEffectEvent(
    (settingsMap: Record<string, SystemSettingsInfo>) => {
      form.setValue("publicUrl", settingsMap.public_url?.value || "");
      form.setValue("corsEnabled", settingsMap.cors_enabled?.value === "true");
      form.setValue("dockerHostIp", settingsMap.docker_host_ip?.value || "");
    },
  );
  useEffect(() => {
    if (settingsData?.data) {
      syncFormFromSettings(settings);
    }
  }, [settingsData, settings]);

  // Persist the three reachability settings. Kept as a standalone routine so
  // both the form submit and the "adopt tailnet URL" action reuse it.
  const doSave = async (data: NetworkAccessFormData) => {
    setIsSaving(true);
    try {
      const toSave = [
        { key: "public_url", value: data.publicUrl || "" },
        { key: "cors_enabled", value: data.corsEnabled.toString() },
        { key: "docker_host_ip", value: data.dockerHostIp || "" },
      ];
      await Promise.all(
        toSave.map(({ key, value }) => {
          const existing = settings[key];
          return existing
            ? updateSetting.mutateAsync({ id: existing.id, setting: { value, isEncrypted: false } })
            : createSetting.mutateAsync({ category: "system", key, value, isEncrypted: false });
        }),
      );
      toastWithCopy.success("Network access settings saved");
      refetchSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save settings";
      toastWithCopy.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const persistedPublicUrl = settings.public_url?.value ?? "";

  // Changing the Public URL while CORS restriction is (or is being) enabled
  // swaps the sole allowed origin — the previously-allowed origin is locked
  // out immediately (§6 risk). Confirm before saving in that case.
  const wouldLockoutCors = (data: NetworkAccessFormData): boolean =>
    !!data.corsEnabled &&
    !!data.publicUrl &&
    persistedPublicUrl.length > 0 &&
    data.publicUrl !== persistedPublicUrl;

  const requestSave = (data: NetworkAccessFormData) => {
    if (wouldLockoutCors(data)) {
      setPendingSubmit(data);
      return;
    }
    return doSave(data);
  };

  const confirmSave = async () => {
    if (!pendingSubmit) return;
    const data = pendingSubmit;
    setPendingSubmit(null);
    await doSave(data);
  };

  const watchedPublicUrl = useWatch({ control: form.control, name: "publicUrl" }) ?? "";
  const corsToggleDisabled = !watchedPublicUrl;
  const corsHelperText = corsToggleDisabled
    ? "Set the Public URL above to enable this option — that's the origin allowed past CORS."
    : "When enabled, only the Public URL above is allowed as a cross-origin request source. When disabled, all origins are allowed.";

  // ---- Tailscale ingress ----
  const {
    data: templates,
    refetch: refetchTemplates,
  } = useStackTemplates({ scope: "host", source: "system", includeLinkedStacks: true });
  const instantiate = useInstantiateTemplate();
  const applyMutation = useStackApply();
  const { registerTask } = useTaskTracker();
  const { data: ingressStatus, isLoading: ingressLoading } = useTailscaleIngressStatus();

  const ingressTemplate: StackTemplateInfo | undefined = templates?.find(
    (t) => t.name === TAILSCALE_INGRESS_TEMPLATE_NAME,
  );
  const hostStack: StackTemplateLinkedStack | undefined = ingressTemplate?.linkedStacks?.find(
    (s) => s.environmentId === null,
  );

  // The stack id to track apply progress for: the one the deploy handler just
  // created (set in an event handler, before the templates query refetches),
  // else the already-linked host stack.
  const activeStackId = ingressStackId ?? hostStack?.id ?? "";
  const applyProgress = useStackApplyProgress(activeStackId);
  // useStackApplyProgress invalidates the stacks.* keys, but the ingress status
  // here is derived from the stack-templates query — refresh it (and the tailnet
  // status) when an apply finishes so the badge/device state catch up.
  useEffect(() => {
    if (applyProgress.finalResult) {
      refetchTemplates();
    }
  }, [applyProgress.finalResult, refetchTemplates]);

  const configured = ingressStatus?.configured ?? true;
  const deviceOnline = ingressStatus?.deviceOnline ?? false;
  const ingressUrl = ingressStatus?.ingressUrl ?? null;
  const stackStatus = hostStack?.status;
  const isDeployed = !!hostStack && stackStatus !== "undeployed" && stackStatus !== "removed";
  const deploying =
    instantiate.isPending ||
    applyMutation.isPending ||
    applyProgress.isApplying ||
    stackStatus === "pending";
  const validated = stackStatus === "synced" && deviceOnline;

  const handleDeploy = async () => {
    if (!ingressTemplate) return;
    try {
      let stackId = hostStack?.id;
      if (!stackId) {
        const created = await instantiate.mutateAsync({ templateId: ingressTemplate.id });
        stackId = created.id;
      }
      setIngressStackId(stackId);
      applyMutation.mutate({ stackId, options: {} });
      registerTask({
        id: stackId,
        type: "stack-apply",
        label: "Deploying Tailscale ingress",
        channel: Channel.STACKS,
      });
      refetchTemplates();
    } catch {
      // Swallow: the global MutationCache.onError already shows an
      // actionable toast for this mutation's real ApiRequestError.
    }
  };

  const handleAdopt = () => {
    if (!ingressUrl) return;
    const next = { ...form.getValues(), publicUrl: ingressUrl };
    form.setValue("publicUrl", ingressUrl, { shouldDirty: true });
    requestSave(next);
  };

  if (settingsError) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Network Access</h1>
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load network settings. Please try refreshing the page.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-300">
            <IconNetwork className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Network Access</h1>
            <p className="text-muted-foreground">
              The one place to see and configure how Mini Infra itself is reached — Public URL, CORS, Docker Host IP, and Tailscale ingress.
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        <div className="grid gap-6">
          {settingsLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(requestSave)} className="space-y-6">
                {/* Public URL & CORS */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconWorld className="h-5 w-5" />
                      <span>Public URL &amp; CORS</span>
                    </CardTitle>
                    <CardDescription>
                      The externally-reachable URL for this instance and its cross-origin request policy
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="publicUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Public URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://mini-infra.example.com" {...field} />
                          </FormControl>
                          <FormDescription>
                            Used for OAuth callback URLs and post-login redirects. Leave empty if serving from the same origin.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="corsEnabled"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">Restrict CORS</FormLabel>
                            <FormDescription>{corsHelperText}</FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              disabled={corsToggleDisabled && !field.value}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                {/* Docker Host IP */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconNetwork className="h-5 w-5" />
                      <span>Docker Host IP</span>
                    </CardTitle>
                    <CardDescription>
                      The public IPv4 of your Docker host, used to create DNS A records in Cloudflare for deployed applications
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="dockerHostIp"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Docker Host IP Address</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g., 192.168.1.100 or 203.0.113.1" {...field} />
                          </FormControl>
                          <FormDescription>
                            IPv4 address of your Docker host (required for DNS record creation).
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                <div className="flex justify-end space-x-2">
                  <Button type="submit" disabled={isSaving || !form.formState.isDirty}>
                    {isSaving ? (
                      <>
                        <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <IconDeviceFloppy className="h-4 w-4 mr-2" />
                        Save Settings
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </Form>
          )}

          {/* Tailscale ingress */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <IconRouter className="h-5 w-5" />
                <span>Tailscale ingress</span>
              </CardTitle>
              <CardDescription>
                Reach this admin UI/API over HTTPS via your tailnet, with no manual reverse proxy or TLS.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {ingressLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !configured ? (
                <Alert>
                  <IconAlertCircle className="h-4 w-4" />
                  <AlertTitle>Tailscale isn&apos;t configured yet</AlertTitle>
                  <AlertDescription>
                    Add your Tailscale OAuth credentials on the{" "}
                    <Link to="/connectivity-tailscale" className="underline underline-offset-4">
                      Tailscale settings page
                    </Link>{" "}
                    before deploying the ingress.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  {/* Status row */}
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-medium">Status:</span>
                    {isDeployed ? (
                      <StackStatusBadge status={stackStatus ?? "undeployed"} />
                    ) : (
                      <span className="text-sm text-muted-foreground">Not deployed</span>
                    )}
                    {isDeployed && stackStatus === "synced" && (
                      <span
                        className={
                          deviceOnline
                            ? "inline-flex items-center gap-1 text-sm text-green-600 dark:text-green-400"
                            : "inline-flex items-center gap-1 text-sm text-amber-600 dark:text-amber-400"
                        }
                      >
                        {deviceOnline ? (
                          <>
                            <IconCircleCheck className="h-4 w-4" /> Device online
                          </>
                        ) : (
                          <>
                            <IconLoader2 className="h-4 w-4 animate-spin" /> Waiting for device…
                          </>
                        )}
                      </span>
                    )}
                  </div>

                  {/* Resolved URL */}
                  {ingressUrl && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Tailnet URL: </span>
                      <a
                        href={ingressUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 underline underline-offset-4"
                      >
                        {ingressUrl}
                        <IconExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap gap-2">
                    {!isDeployed || stackStatus === "error" ? (
                      <Button onClick={handleDeploy} disabled={deploying || !ingressTemplate}>
                        {deploying ? (
                          <>
                            <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                            Deploying...
                          </>
                        ) : (
                          <>
                            <IconRocket className="h-4 w-4 mr-2" />
                            Deploy Tailscale ingress
                          </>
                        )}
                      </Button>
                    ) : deploying ? (
                      <Button disabled>
                        <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                        Deploying...
                      </Button>
                    ) : null}

                    {validated && ingressUrl && (
                      <Button
                        variant="secondary"
                        onClick={handleAdopt}
                        disabled={isSaving || persistedPublicUrl === ingressUrl}
                      >
                        <IconWorld className="h-4 w-4 mr-2" />
                        {persistedPublicUrl === ingressUrl
                          ? "Public URL adopted"
                          : "Use as Public URL"}
                      </Button>
                    )}
                  </div>

                  {/* Post-deploy guidance */}
                  {isDeployed && stackStatus === "synced" && !deviceOnline && (
                    <Alert>
                      <IconLoader2 className="h-4 w-4 animate-spin" />
                      <AlertDescription>
                        The sidecar is running; waiting for its tailnet device to come online. This usually takes a few seconds. HTTPS also requires MagicDNS + HTTPS certificates enabled in your Tailscale admin console.
                      </AlertDescription>
                    </Alert>
                  )}

                  {validated && ingressUrl && (
                    <Alert>
                      <IconAlertCircle className="h-4 w-4" />
                      <AlertTitle>Before you rely on this URL for login</AlertTitle>
                      <AlertDescription>
                        Add <code>{ingressUrl}</code> as an authorized redirect URI on your Google OAuth client, or the login callback will be rejected when reaching Mini Infra through the tailnet.
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog
        open={pendingSubmit !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSubmit(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconAlertCircle className="h-5 w-5" />
              Change the Public URL while CORS is restricted?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  CORS restriction is enabled, so only the Public URL is allowed as a cross-origin source. Saving this change will:
                </p>
                <ul className="list-disc list-inside text-sm space-y-1">
                  <li>
                    Immediately stop allowing the previous origin{" "}
                    {persistedPublicUrl && <code>{persistedPublicUrl}</code>}
                  </li>
                  <li>
                    Allow only the new Public URL going forward
                  </li>
                </ul>
                <p className="text-sm">
                  If you&apos;re currently using Mini Infra from the old origin, you may be blocked until you navigate to the new one.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSave}>Save anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
