import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
  useSystemSettings,
  useCreateSystemSetting,
  useUpdateSystemSetting,
} from "@/hooks/use-settings";
import {
  IconAlertCircle,
  IconDeviceFloppy,
  IconLoader2,
  IconSettings,
  IconBrandDocker,
  IconNetwork,
  IconShield,
  IconHistory,
  IconClock,
  IconWorld,
  IconKey,
  IconRefresh,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SystemSettingsInfo } from "@mini-infra/types";

// System settings schema
const systemSettingsSchema = z.object({
  // Public URL and CORS
  publicUrl: z.string().optional().refine(
    (val) => !val || /^https?:\/\//.test(val),
    "Must be a valid URL starting with http:// or https://"
  ),
  corsEnabled: z.boolean(),

  // Production mode setting
  isProduction: z.boolean(),

  // Backup container settings
  backupDockerImage: z
    .string()
    .min(1, "Backup Docker image is required")
    .regex(
      /^[a-zA-Z0-9\-._/]+(?::[a-zA-Z0-9\-._]+)?$/,
      "Invalid Docker image format (e.g., postgres:15-alpine, ghcr.io/user/repo:latest)",
    ),

  // Restore container settings
  restoreDockerImage: z
    .string()
    .min(1, "Restore Docker image is required")
    .regex(
      /^[a-zA-Z0-9\-._/]+(?::[a-zA-Z0-9\-._]+)?$/,
      "Invalid Docker image format (e.g., postgres:15-alpine, ghcr.io/user/repo:latest)",
    ),

  // Docker Host IP Configuration
  dockerHostIp: z
    .string()
    .optional()
    .refine(
      (val) => !val || /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(val),
      "Must be a valid IPv4 address (e.g., 192.168.1.100)"
    ),

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

// Default Docker images and settings
const DEFAULT_BACKUP_IMAGE = "postgres:15-alpine";
const DEFAULT_RESTORE_IMAGE = "postgres:15-alpine";

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );
  const [isSaving, setIsSaving] = useState(false);
  const [confirmRegenerateOpen, setConfirmRegenerateOpen] = useState(false);
  const queryClient = useQueryClient();

  // Security secrets
  const {
    data: secrets,
    isLoading: secretsLoading,
  } = useQuery<{ app_secret: string; app_secret_id: string | null }>({
    queryKey: ["security-secrets"],
    queryFn: async () => {
      const res = await fetch("/api/settings/security");
      if (!res.ok) throw new Error("Failed to fetch security secrets");
      return res.json();
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/security/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to regenerate secret");
      }
      return res.json() as Promise<{ message: string; warning: string }>;
    },
    onSuccess: (data) => {
      toastWithCopy.success(data.message);
      setTimeout(() => toastWithCopy.warning(data.warning), 1000);
      queryClient.invalidateQueries({ queryKey: ["security-secrets"] });
    },
    onError: (error: Error) => toastWithCopy.error(error.message),
  });

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
      publicUrl: "",
      corsEnabled: false,
      isProduction: false,
      backupDockerImage: DEFAULT_BACKUP_IMAGE,
      restoreDockerImage: DEFAULT_RESTORE_IMAGE,
      dockerHostIp: "",
      userEventsRetentionDays: "30",
    },
    mode: "onChange",
  });


  // Update form when settings are loaded
  useEffect(() => {
    if (settingsData?.data) {
      const settingsMap = settingsData.data.reduce(
        (acc, setting) => {
          acc[setting.key] = setting;
          return acc;
        },
        {} as Record<string, SystemSettingsInfo>,
      );
      setSettings(settingsMap);

      // Update form with current values
      form.setValue(
        "publicUrl",
        settingsMap.public_url?.value || "",
      );
      form.setValue(
        "corsEnabled",
        settingsMap.cors_enabled?.value === "true",
      );
      form.setValue(
        "isProduction",
        settingsMap.is_production?.value === "true",
      );
      form.setValue(
        "backupDockerImage",
        settingsMap.backup_docker_image?.value || DEFAULT_BACKUP_IMAGE,
      );
      form.setValue(
        "restoreDockerImage",
        settingsMap.restore_docker_image?.value || DEFAULT_RESTORE_IMAGE,
      );
      form.setValue(
        "dockerHostIp",
        settingsMap.docker_host_ip?.value || "",
      );
      form.setValue(
        "userEventsRetentionDays",
        settingsMap.user_events_retention_days?.value || "30",
      );
    }

  }, [settingsData, form]);

  const handleSubmit = async (data: SystemSettingsFormData) => {
    setIsSaving(true);
    try {
      const systemSettingsToSave = [
        {
          category: "system" as const,
          key: "public_url",
          value: data.publicUrl || "",
          isEncrypted: false,
        },
        {
          category: "system" as const,
          key: "cors_enabled",
          value: data.corsEnabled.toString(),
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
          key: "backup_docker_image",
          value: data.backupDockerImage,
          isEncrypted: false,
        },
        {
          category: "system" as const,
          key: "restore_docker_image",
          value: data.restoreDockerImage,
          isEncrypted: false,
        },
        {
          category: "system" as const,
          key: "docker_host_ip",
          value: data.dockerHostIp || "",
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
      toastWithCopy.error("Failed to save system settings");
    } finally {
      setIsSaving(false);
    }
  };


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
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
            <IconSettings className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">System Settings</h1>
            <p className="text-muted-foreground">
              Configure system-wide settings for backup, restore, and HAProxy load balancer operations
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        <div className="grid gap-6">
          {/* Description */}
          <div className="space-y-2">
            <p className="text-muted-foreground">
              These settings control Docker containers, networks, and HAProxy
              load balancer for deployment operations.
            </p>
          </div>

          {settingsLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(handleSubmit)}
                className="space-y-6"
              >
                {/* Public URL & CORS */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconWorld className="h-5 w-5" />
                      <span>Public URL &amp; CORS</span>
                    </CardTitle>
                    <CardDescription>
                      Configure the externally-reachable URL for this instance and cross-origin request policy
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
                            <Input
                              placeholder="https://mini-infra.example.com"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            The externally-reachable URL for this instance. Used for OAuth callback URLs and post-login redirects. Leave empty if serving from the same origin.
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
                            <FormLabel className="text-base">
                              Restrict CORS
                            </FormLabel>
                            <FormDescription>
                              When enabled, only the Public URL above is allowed as a cross-origin request source. When disabled, all origins are allowed.
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

                {/* Backup Container Settings */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconBrandDocker className="h-5 w-5" />
                      <span>Backup Container Settings</span>
                    </CardTitle>
                    <CardDescription>
                      Configure the Docker container used for database backup
                      operations
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="backupDockerImage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Docker Image</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="postgres:15-alpine"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Docker image for backup operations (e.g.,
                            postgres:15-alpine, myregistry/postgres:latest)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                {/* Restore Container Settings */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconBrandDocker className="h-5 w-5" />
                      <span>Restore Container Settings</span>
                    </CardTitle>
                    <CardDescription>
                      Configure the Docker container used for database restore
                      operations
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="restoreDockerImage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Docker Image</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="postgres:15-alpine"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Docker image for restore operations (e.g.,
                            postgres:15-alpine, myregistry/postgres:latest)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                {/* Docker Host Network Configuration */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconNetwork className="h-5 w-5" />
                      <span>Docker Host Network Configuration</span>
                    </CardTitle>
                    <CardDescription>
                      Configure the Docker host IP address for DNS record creation
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-md bg-muted p-4 space-y-2">
                      <h4 className="text-sm font-medium">What is this?</h4>
                      <p className="text-sm text-muted-foreground">
                        When deploying applications with DNS records, the system needs to know the public IP address
                        of your Docker host to create proper DNS A records in Cloudflare.
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        This is typically your server's public IP address or the IP where HAProxy is accessible.
                      </p>
                    </div>

                    <FormField
                      control={form.control}
                      name="dockerHostIp"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Docker Host IP Address</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="e.g., 192.168.1.100 or 203.0.113.1"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            IPv4 address of your Docker host (required for DNS record creation)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Alert>
                      <IconAlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        This IP address will be used to create DNS A records for deployed applications.
                        Make sure it's accessible from the internet if you're deploying public-facing services.
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

                {/* Application Secret */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconKey className="h-5 w-5" />
                      <span>Application Secret</span>
                    </CardTitle>
                    <CardDescription>
                      A single secret used for JWT signing, API key hashing, and credential encryption. Auto-generated on first boot.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3 rounded-lg border p-4">
                      <div className="flex items-center justify-between">
                        <div className="space-y-1">
                          <h3 className="font-semibold text-sm">App Secret</h3>
                          <p className="text-sm text-muted-foreground">
                            Used for all authentication and encryption operations
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmRegenerateOpen(true)}
                          disabled={regenerateMutation.isPending}
                        >
                          {regenerateMutation.isPending ? (
                            <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <IconRefresh className="h-4 w-4 mr-2" />
                          )}
                          Regenerate
                        </Button>
                      </div>
                      <div className="rounded bg-muted p-3 font-mono text-sm">
                        {secretsLoading ? <Skeleton className="h-5 w-full" /> : (secrets?.app_secret || "••••••••")}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Regenerating will invalidate all active sessions and break all existing API keys.
                        Users will need to log in again and create new API keys.
                      </p>
                    </div>
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

      <Dialog open={confirmRegenerateOpen} onOpenChange={setConfirmRegenerateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate App Secret?</DialogTitle>
            <DialogDescription>
              This will invalidate all active user sessions and break all
              existing API keys. All users will need to log in again and create
              new API keys. Are you sure you want to continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRegenerateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                regenerateMutation.mutate();
                setConfirmRegenerateOpen(false);
              }}
              disabled={regenerateMutation.isPending}
            >
              {regenerateMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
