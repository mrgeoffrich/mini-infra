import { useState, useEffect, useEffectEvent, useMemo } from "react";
import { useForm } from "react-hook-form";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { useSystemInfo } from "@/hooks/use-system-info";
import {
  IconAlertCircle,
  IconDeviceFloppy,
  IconLoader2,
  IconLock,
  IconSettings,
  IconShield,
  IconHistory,
  IconClock,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import { SystemSettingsInfo } from "@mini-infra/types";

// System settings schema. Public URL, CORS, and Docker Host IP now live on the
// Network Access page (they describe how Mini Infra is reached); this page
// keeps the remaining system-wide toggles.
const systemSettingsSchema = z.object({
  // HTTPS enforcement
  httpsOnlyMode: z.boolean(),

  // Production mode setting
  isProduction: z.boolean(),

  // User Events Retention Settings
  userEventsRetentionDays: z
    .string()
    .optional()
    .refine(
      (val) => !val || (Number(val) >= 1 && Number(val) <= 365),
      "Retention days must be between 1 and 365"
    ),
});

type SystemSettingsFormData = z.infer<typeof systemSettingsSchema>;

export default function SystemSettingsPage() {
  const [isSaving, setIsSaving] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<SystemSettingsFormData | null>(null);

  const systemInfo = useSystemInfo();

  // Fetch existing system settings for system category
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings,
  } = useSystemSettings({
    filters: { category: "system", isActive: true },
    limit: 50,
  });

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<SystemSettingsFormData>({
    resolver: zodResolver(systemSettingsSchema),
    defaultValues: {
      httpsOnlyMode: false,
      isProduction: false,
      userEventsRetentionDays: "30",
    },
    mode: "onChange",
  });


  // Derive the settings map from query data instead of mirroring it in state.
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

  // Update form when settings are loaded. Wrapping the form.setValue calls in
  // `useEffectEvent` keeps the setState-style writes out of the reactive
  // effect body (avoids set-state-in-effect).
  const syncFormFromSettings = useEffectEvent(
    (settingsMap: Record<string, SystemSettingsInfo>) => {
      form.setValue(
        "httpsOnlyMode",
        settingsMap.https_only_mode?.value === "true",
      );
      form.setValue(
        "isProduction",
        settingsMap.is_production?.value === "true",
      );
      form.setValue(
        "userEventsRetentionDays",
        settingsMap.user_events_retention_days?.value || "30",
      );
    },
  );
  useEffect(() => {
    if (settingsData?.data) {
      syncFormFromSettings(settings);
    }
  }, [settingsData, settings]);

  const handleSubmit = async (data: SystemSettingsFormData) => {
    setIsSaving(true);
    try {
      const systemSettingsToSave = [
        {
          category: "system" as const,
          key: "https_only_mode",
          value: data.httpsOnlyMode.toString(),
          isEncrypted: false,
        },
        {
          category: "system" as const,
          key: "is_production",
          value: data.isProduction.toString(),
          isEncrypted: false,
        },
        {
          category: "system" as const,
          key: "user_events_retention_days",
          value: data.userEventsRetentionDays || "30",
          isEncrypted: false,
        },
      ];

      const promises = systemSettingsToSave.map(
        async ({ category, key, value, isEncrypted }) => {
          const existingSetting = settings[key];

          if (existingSetting) {
            // Update existing setting
            return updateSetting.mutateAsync({
              id: existingSetting.id,
              setting: { value, isEncrypted },
            });
          } else {
            // Create new setting
            return createSetting.mutateAsync({
              category,
              key,
              value,
              isEncrypted,
            });
          }
        },
      );

      await Promise.all(promises);

      toastWithCopy.success("System settings saved successfully");

      // Refetch settings to get updated data
      refetchSettings();
    } catch (error) {
      console.error("Failed to save system settings:", error);
      const message = error instanceof Error ? error.message : "Failed to save system settings";
      toastWithCopy.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Intercept submit so newly enabling HTTPS-only mode shows a confirm modal
  // first — the lockout cost (HSTS pins for a year, page won't load over HTTP)
  // is high enough that a typo on the toggle deserves a deliberate Yes.
  const onFormSubmit = (data: SystemSettingsFormData) => {
    const wasHttpsOnly = settings.https_only_mode?.value === "true";
    if (!wasHttpsOnly && data.httpsOnlyMode) {
      setPendingSubmit(data);
      return;
    }
    return handleSubmit(data);
  };

  const confirmHttpsOnlyEnable = async () => {
    if (!pendingSubmit) return;
    const data = pendingSubmit;
    setPendingSubmit(null);
    await handleSubmit(data);
  };

  // HTTPS-only requires an https:// Public URL, which now lives on the Network
  // Access page. Gate the toggle on the *persisted* public_url (the server
  // validates against the same stored value), and point the operator there.
  const persistedPublicUrl = settings.public_url?.value ?? "";
  const httpsOnlyToggleDisabled = !persistedPublicUrl.startsWith("https://");
  const httpsOnlyHelperText = httpsOnlyToggleDisabled
    ? "Set an https:// Public URL on the Network Access page to enable this option."
    : "When enabled, the server emits HSTS, upgrades insecure requests, and marks auth cookies Secure. Browsers will then refuse plain-HTTP access.";


  if (settingsError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center space-x-2">
          <h1 className="text-2xl font-semibold">System Settings</h1>
        </div>

        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load system settings. Please try refreshing the page.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {systemInfo.forceInsecureOverride && (
        <div className="px-4 lg:px-6">
          <Alert variant="default" className="border-amber-500 text-amber-700 dark:text-amber-400">
            <IconLock className="h-4 w-4" />
            <AlertDescription>
              Server is running with <code>MINI_INFRA_FORCE_INSECURE=true</code> — HTTPS-only mode is overridden at the process level. The toggle below is ignored until that env var is removed and the server restarted.
            </AlertDescription>
          </Alert>
        </div>
      )}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
            <IconSettings className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">System Settings</h1>
            <p className="text-muted-foreground">
              System-wide toggles for this instance. Looking for Public URL, CORS, or Docker Host IP? They moved to{" "}
              <Link to="/network-access" className="underline underline-offset-4">
                Network Access
              </Link>
              .
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
              <Skeleton className="h-48 w-full" />
            </div>
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onFormSubmit)}
                className="space-y-6"
              >
                {/* HTTPS enforcement */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconLock className="h-5 w-5" />
                      <span>HTTPS enforcement</span>
                    </CardTitle>
                    <CardDescription>
                      Enforce HTTPS for this instance. Requires an https:// Public URL, configured on the Network Access page.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="httpsOnlyMode"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">
                              HTTPS-only mode
                            </FormLabel>
                            <FormDescription>
                              {httpsOnlyHelperText}
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              disabled={httpsOnlyToggleDisabled && !field.value}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                {/* Production Mode Setting */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconShield className="h-5 w-5" />
                      <span>Production Mode</span>
                    </CardTitle>
                    <CardDescription>
                      Mark this instance as a production system to enable production-specific UI indicators
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="isProduction"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">
                              Production System
                            </FormLabel>
                            <FormDescription>
                              Enable this to indicate this is a production Mini Infra instance.
                              When enabled, the system title will display a production indicator.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <Alert>
                      <IconAlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        This setting is for display purposes only and does not affect system functionality.
                        It helps visually distinguish production instances from development or staging environments.
                      </AlertDescription>
                    </Alert>
                  </CardContent>
                </Card>

                {/* User Events Retention Configuration */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconHistory className="h-5 w-5" />
                      <span>User Events Configuration</span>
                    </CardTitle>
                    <CardDescription>
                      Configure retention and cleanup settings for user event logs
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-md bg-muted p-4 space-y-2">
                      <h4 className="text-sm font-medium">What are User Events?</h4>
                      <p className="text-sm text-muted-foreground">
                        User Events track long-running operations like deployments, backups, certificate renewals,
                        and system maintenance. Events include detailed logs and progress tracking.
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        Old events are automatically cleaned up based on the retention period to manage database size.
                      </p>
                    </div>

                    <FormField
                      control={form.control}
                      name="userEventsRetentionDays"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Event Retention Period (Days)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="30"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            User events older than this many days will be automatically deleted (1-365 days).
                            Default is 30 days.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Alert>
                      <IconClock className="h-4 w-4" />
                      <AlertDescription>
                        Cleanup runs automatically daily at 2 AM UTC. Deleted events cannot be recovered.
                      </AlertDescription>
                    </Alert>
                  </CardContent>
                </Card>

                {/* Actions */}
                <div className="flex justify-end space-x-2">
                  <Button
                    type="submit"
                    disabled={isSaving || !form.formState.isDirty}
                  >
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
              <IconLock className="h-5 w-5" />
              Enable HTTPS-only mode?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Saving will start enforcing HTTPS for this instance:
                </p>
                <ul className="list-disc list-inside text-sm space-y-1">
                  <li>
                    Browsers will be told to upgrade insecure requests (CSP <code>upgrade-insecure-requests</code>)
                  </li>
                  <li>
                    HSTS will be sent — <strong>browsers will pin HTTPS for up to 1 year</strong>; disabling later won&apos;t immediately let HTTP back in until the pin expires or site data is cleared
                  </li>
                  <li>
                    Auth cookies will be marked <code>Secure</code>; the browser will drop them on plain HTTP, which means anyone still on HTTP will be silently logged out
                  </li>
                </ul>
                <p className="text-sm">
                  Your current connection is{" "}
                  {systemInfo.protocol === "https" ? (
                    <span className="font-medium text-green-600 dark:text-green-400">HTTPS ✓</span>
                  ) : (
                    <span className="font-medium text-red-600 dark:text-red-400">HTTP ✗</span>
                  )}
                  .
                </p>
                {systemInfo.protocol !== "https" && (
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">
                    The server will reject this change because the request itself is HTTP. Reload the page over HTTPS first.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmHttpsOnlyEnable}>
              Enable HTTPS-only mode
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
