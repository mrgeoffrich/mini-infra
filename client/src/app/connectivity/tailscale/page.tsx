import { useState, useEffect, useRef, useCallback } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { TagListInput } from "@/components/ui/tag-list-input";
import { CopyableCodeBlock } from "@/components/ui/copyable-code-block";
import {
  IconNetwork,
  IconCircleCheck,
  IconCircleX,
  IconAlertCircle,
  IconLoader2,
  IconEye,
  IconEyeOff,
  IconKey,
  IconShield,
  IconTag,
  IconExternalLink,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { TAILSCALE_DEFAULT_TAG, type TailscaleSettingsResponse } from "@mini-infra/types";
import { buildAclSnippet } from "@/lib/tailscale/build-acl-snippet";

const tagRegex = /^tag:[a-z0-9-]+$/;

const tailscaleSettingsSchema = z.object({
  clientId: z.string().min(8, "OAuth client_id must be at least 8 characters"),
  clientSecret: z.string().refine(
    (v) => v.length === 0 || v.length >= 8,
    { message: "OAuth client_secret must be at least 8 characters" },
  ),
  extraTags: z.array(z.string().regex(tagRegex, "Tags must match tag:[a-z0-9-]+")),
});

type TailscaleSettingsFormData = z.infer<typeof tailscaleSettingsSchema>;

interface ValidationState {
  isValidating: boolean;
  isSuccess: boolean;
  error: string | null;
  errorCode: string | null;
}

const initialValidationState: ValidationState = {
  isValidating: false,
  isSuccess: false,
  error: null,
  errorCode: null,
};

async function fetchSettings(): Promise<TailscaleSettingsResponse["data"]> {
  const res = await fetch("/api/settings/tailscale", {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to load Tailscale settings (HTTP ${res.status})`);
  }
  const body = (await res.json()) as TailscaleSettingsResponse;
  return body.data;
}

async function saveSettings(payload: {
  client_id: string;
  client_secret?: string;
  extra_tags: string[];
}): Promise<TailscaleSettingsResponse["data"]> {
  const res = await fetch("/api/settings/tailscale", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to save (HTTP ${res.status})`);
  }
  const body = (await res.json()) as TailscaleSettingsResponse;
  return body.data;
}

interface TestResult {
  isValid: boolean;
  message: string;
  errorCode?: string;
}

async function probeTagOwnership(): Promise<TestResult> {
  const res = await fetch("/api/settings/tailscale/probe-tag-ownership", {
    method: "POST",
    credentials: "include",
  });
  const body = await res.json();
  return body.data as TestResult;
}

function friendlyErrorMessage(errorCode: string | undefined, fallback: string): string {
  switch (errorCode) {
    case "INVALID_CLIENT":
      return "Tailscale rejected these credentials. Double-check the client ID and secret, and confirm the OAuth client has auth_keys (write) and devices:core (write) scopes.";
    case "INVALID_TAG":
      return `OAuth client doesn't own ${TAILSCALE_DEFAULT_TAG}. Assign the tag to your OAuth client at https://login.tailscale.com/admin/settings/oauth, then paste the ACL snippet above into your tailnet policy.`;
    case "MISSING_CREDENTIALS":
      return "Save OAuth credentials first, then try again.";
    case "NETWORK_ERROR":
      return "Couldn't reach Tailscale — check your network or try again.";
    default:
      return fallback;
  }
}

export default function TailscaleSettingsPage() {
  const queryClient = useQueryClient();
  const [showSecret, setShowSecret] = useState(false);
  const [validationState, setValidationState] = useState<ValidationState>(
    initialValidationState,
  );

  const form = useForm<TailscaleSettingsFormData>({
    resolver: zodResolver(tailscaleSettingsSchema),
    defaultValues: { clientId: "", clientSecret: "", extraTags: [] },
    mode: "onChange",
  });

  // useWatch (vs form.watch) keeps the React Compiler happy and re-renders
  // only this slice of the form instead of the whole component on every
  // keystroke.
  const watchedExtraTags =
    useWatch({ control: form.control, name: "extraTags" }) ?? [];
  const livePreviewSnippet = buildAclSnippet(watchedExtraTags);

  const {
    data: settings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useQuery<TailscaleSettingsResponse["data"]>({
    queryKey: ["tailscaleSettings"],
    queryFn: fetchSettings,
    refetchOnWindowFocus: false,
  });

  // Sync the form when the loaded settings change. Mirrors the
  // `syncSettings` pattern used by the Cloudflare connectivity page —
  // routing the call through a ref keeps `form.reset` out of the effect's
  // reactive body so the set-state-in-effect rule doesn't trip.
  const syncSettings = useCallback(() => {
    if (!settings) return;
    form.reset({
      clientId: settings.clientId ?? "",
      clientSecret: "",
      extraTags: settings.extraTags ?? [],
    });
  }, [settings, form]);
  const syncSettingsRef = useRef(syncSettings);
  useEffect(() => {
    syncSettingsRef.current = syncSettings;
  }, [syncSettings]);
  useEffect(() => {
    syncSettingsRef.current();
  }, [settings]);

  const onSubmit = async (data: TailscaleSettingsFormData) => {
    setValidationState({ ...initialValidationState, isValidating: true });
    try {
      const requireSecret = !settings?.hasClientSecret;
      if (requireSecret && data.clientSecret.length === 0) {
        setValidationState({
          isValidating: false,
          isSuccess: false,
          error: "OAuth client_secret is required on first save.",
          errorCode: "MISSING_CREDENTIALS",
        });
        return;
      }

      const saved = await saveSettings({
        client_id: data.clientId,
        client_secret: data.clientSecret.length > 0 ? data.clientSecret : undefined,
        extra_tags: data.extraTags,
      });

      queryClient.setQueryData<TailscaleSettingsResponse["data"]>(
        ["tailscaleSettings"],
        saved,
      );

      if (!saved.isValid) {
        const code = (saved.validationMessage ?? "").includes("OAuth client doesn")
          ? "INVALID_TAG"
          : (saved.validationMessage ?? "").includes("Tailscale rejected")
            ? "INVALID_CLIENT"
            : "TAILSCALE_API_ERROR";
        setValidationState({
          isValidating: false,
          isSuccess: false,
          error: friendlyErrorMessage(code, saved.validationMessage ?? ""),
          errorCode: code,
        });
        toast.error("Tailscale validation failed");
      } else {
        // OAuth mint succeeded — also probe tag ownership to surface
        // INVALID_TAG before the operator wires Phase 3 sidecars.
        const probe = await probeTagOwnership();
        if (!probe.isValid) {
          setValidationState({
            isValidating: false,
            isSuccess: false,
            error: friendlyErrorMessage(probe.errorCode, probe.message),
            errorCode: probe.errorCode ?? "INVALID_TAG",
          });
          toast.error("Tailscale tag ownership check failed");
        } else {
          setValidationState({
            isValidating: false,
            isSuccess: true,
            error: null,
            errorCode: null,
          });
          toast.success("Tailscale connection validated and saved");
        }
      }

      form.reset({
        clientId: saved.clientId ?? data.clientId,
        clientSecret: "",
        extraTags: saved.extraTags ?? data.extraTags,
      });
      await queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });

      setTimeout(() => {
        setValidationState((prev) =>
          prev.isSuccess ? { ...prev, isSuccess: false } : prev,
        );
      }, 5000);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save Tailscale settings";
      setValidationState({
        isValidating: false,
        isSuccess: false,
        error: message,
        errorCode: null,
      });
      toast.error(message);
    }
  };

  if (settingsError) {
    const message =
      settingsError instanceof Error
        ? settingsError.message
        : "Unknown error";
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <PageHeader />
        <div className="px-4 lg:px-6 max-w-4xl">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load Tailscale settings: {message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <PageHeader />

      <div className="px-4 lg:px-6 max-w-4xl">
        <Card>
          <CardHeader>
            <CardTitle>Tailscale OAuth Configuration</CardTitle>
            <CardDescription>
              Mini Infra mints short-lived, ephemeral authkeys against your
              tailnet on demand. Set the tag list first, paste the ACL snippet
              into your tailnet policy, then save the OAuth client credentials.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {settingsLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-20" />
                <Skeleton className="h-32" />
                <Skeleton className="h-20" />
                <Skeleton className="h-10 w-40" />
              </div>
            ) : (
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="space-y-6"
                  data-tour="tailscale-settings-form"
                >
                  <SectionHeading
                    icon={<IconTag className="size-4" />}
                    title="1. Tags"
                    description={`Mini Infra always mints authkeys with ${TAILSCALE_DEFAULT_TAG}. Add extra tags here if you want them on every minted device.`}
                  />
                  <FormField
                    control={form.control}
                    name="extraTags"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="sr-only">Extra tags</FormLabel>
                        <FormControl>
                          <TagListInput
                            value={field.value}
                            onChange={field.onChange}
                            pinnedHead={[TAILSCALE_DEFAULT_TAG]}
                            pinnedTooltip="Required — Mini Infra mints every authkey with this tag, so it cannot be removed."
                            validate={(raw) =>
                              tagRegex.test(raw)
                                ? null
                                : "Tags must match tag:[a-z0-9-]+"
                            }
                            placeholder="tag:my-extra"
                            ariaLabel="Tailscale tag list"
                          />
                        </FormControl>
                        <FormDescription>
                          Adding tags affects future tailnet devices only. Existing
                          devices keep their original tag set until reapplied.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Separator />

                  <SectionHeading
                    icon={<IconShield className="size-4" />}
                    title="2. Bootstrap ACL snippet"
                    description={
                      <>
                        Copy this and paste it into your tailnet policy at{" "}
                        <a
                          href="https://login.tailscale.com/admin/acls"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          login.tailscale.com/admin/acls
                          <IconExternalLink className="inline ml-1 h-3 w-3" />
                        </a>
                        . The snippet is regenerated live from the tag list above.
                      </>
                    }
                  />
                  <CopyableCodeBlock
                    value={livePreviewSnippet}
                    language="json"
                    ariaLabel="Tailscale ACL bootstrap snippet"
                  />

                  <Separator />

                  <SectionHeading
                    icon={<IconKey className="size-4" />}
                    title="3. OAuth credentials"
                    description={
                      <>
                        Create an OAuth client at{" "}
                        <a
                          href="https://login.tailscale.com/admin/settings/oauth"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          login.tailscale.com/admin/settings/oauth
                          <IconExternalLink className="inline ml-1 h-3 w-3" />
                        </a>{" "}
                        with scopes <code>auth_keys</code> (write) and{" "}
                        <code>devices:core</code> (write), and assign{" "}
                        <code>{TAILSCALE_DEFAULT_TAG}</code> to the OAuth client.
                      </>
                    }
                  />
                  <FormField
                    control={form.control}
                    name="clientId"
                    render={({ field }) => (
                      <FormItem data-tour="tailscale-client-id-input">
                        <FormLabel>Client ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="kXXXXXXCNTRL"
                            autoComplete="off"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Public identifier of your Tailscale OAuth client.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="clientSecret"
                    render={({ field }) => (
                      <FormItem data-tour="tailscale-client-secret-input">
                        <FormLabel>Client secret</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type={showSecret ? "text" : "password"}
                              placeholder={
                                settings?.hasClientSecret
                                  ? "Stored — leave blank to keep, paste a new one to rotate"
                                  : "tskey-client-..."
                              }
                              autoComplete="off"
                              {...field}
                              className="pr-10"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                              onClick={() => setShowSecret(!showSecret)}
                            >
                              {showSecret ? (
                                <IconEyeOff className="h-4 w-4" />
                              ) : (
                                <IconEye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </FormControl>
                        <FormDescription>
                          {settings?.hasClientSecret
                            ? "A secret is already stored. Paste a fresh one to rotate; leave blank to keep the existing value."
                            : "Tailscale shows the secret once at creation — paste it now."}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex gap-3">
                    <Button
                      type="submit"
                      disabled={validationState.isValidating}
                      data-tour="tailscale-validate-button"
                    >
                      {validationState.isValidating ? (
                        <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <IconCircleCheck className="mr-2 h-4 w-4" />
                      )}
                      {validationState.isValidating
                        ? "Validating…"
                        : "Validate & Save"}
                    </Button>
                  </div>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>

        {validationState.isSuccess && (
          <Alert className="bg-green-50 border-green-200 mt-6">
            <IconCircleCheck className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700">
              Tailscale connection validated. Mini Infra can now mint authkeys
              against your tailnet for the configured tags.
            </AlertDescription>
          </Alert>
        )}

        {validationState.error && (
          <Alert variant="destructive" className="mt-6">
            <IconCircleX className="h-4 w-4" />
            <AlertDescription>{validationState.error}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <div className="px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
          <IconNetwork className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-3xl font-bold">Tailscale Configuration</h1>
          <p className="text-muted-foreground">
            Configure Tailscale OAuth credentials so Mini Infra can mint
            ephemeral authkeys for tailnet-attached services.
          </p>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        <span>{title}</span>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
