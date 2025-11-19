import { useState, useEffect } from "react";
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
  useConnectivityStatus,
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
  IconDatabase,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import { SystemSettingsInfo } from "@mini-infra/types";
import { AzureContainerSelector } from "@/components/AzureContainerSelector";

// System settings schema
const systemSettingsSchema = z.object({
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

  // HAProxy port configuration (optional overrides)
  haproxyHttpPort: z
    .string()
    .optional()
    .refine(
      (val) => !val || (Number(val) >= 1 && Number(val) <= 65535),
      "Port must be between 1 and 65535"
    ),
  haproxyHttpsPort: z
    .string()
    .optional()
    .refine(
      (val) => !val || (Number(val) >= 1 && Number(val) <= 65535),
      "Port must be between 1 and 65535"
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
  const [defaultContainer, setDefaultContainer] = useState<string>("");
  const [isSavingDefaultContainer, setIsSavingDefaultContainer] =
    useState(false);

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

  // Fetch HAProxy settings
  const {
    data: haproxySettingsData,
    isLoading: haproxyLoading,
    refetch: refetchHAProxySettings,
  } = useSystemSettings({
    filters: { category: "haproxy", isActive: true },
    limit: 10,
  });

  // Fetch default container setting
  const {
    data: defaultContainerData,
    isLoading: defaultContainerLoading,
  } = useSystemSettings({
    filters: {
      category: "system",
      key: "default_postgres_backup_container",
      isActive: true,
    },
    limit: 1,
  });

  // Fetch Azure connectivity status
  const {
    data: connectivityData,
  } = useConnectivityStatus({
    filters: { service: "azure" },
    limit: 1,
  });

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<SystemSettingsFormData>({
    resolver: zodResolver(systemSettingsSchema),
    defaultValues: {
      isProduction: false,
      backupDockerImage: DEFAULT_BACKUP_IMAGE,
      restoreDockerImage: DEFAULT_RESTORE_IMAGE,
      haproxyHttpPort: "",
      haproxyHttpsPort: "",
      dockerHostIp: "",
      userEventsRetentionDays: "30",
    },
    mode: "onChange",
  });

  // Get Azure connectivity status
  const azureConnectivity = connectivityData?.data?.[0];
  const isAzureConnected = azureConnectivity?.status === "connected";


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

    if (haproxySettingsData?.data) {
      const haproxyMap = haproxySettingsData.data.reduce(
        (acc, setting) => {
          acc[setting.key] = setting;
          return acc;
        },
        {} as Record<string, SystemSettingsInfo>,
      );

      // Merge HAProxy settings into settings map
      setSettings(prev => ({ ...prev, ...haproxyMap }));

      // Update form with HAProxy port values
      form.setValue(
        "haproxyHttpPort",
        haproxyMap.haproxy_http_port?.value || "",
      );
      form.setValue(
        "haproxyHttpsPort",
        haproxyMap.haproxy_https_port?.value || "",
      );
    }
  }, [settingsData, haproxySettingsData, form]);

  // Update default container when loaded
  useEffect(() => {
    if (defaultContainerData?.data?.[0]?.value) {
      setDefaultContainer(defaultContainerData.data[0].value);
    }
  }, [defaultContainerData]);

  const handleSubmit = async (data: SystemSettingsFormData) => {
    setIsSaving(true);
    try {
      const systemSettingsToSave = [
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

      // Add HAProxy settings if provided
      const haproxySettingsToSave: Array<{category: "haproxy"; key: string; value: string; isEncrypted: boolean}> = [];

      if (data.haproxyHttpPort) {
        haproxySettingsToSave.push({
          category: "haproxy",
          key: "haproxy_http_port",
          value: data.haproxyHttpPort,
          isEncrypted: false,
        });
      }

      if (data.haproxyHttpsPort) {
        haproxySettingsToSave.push({
          category: "haproxy",
          key: "haproxy_https_port",
          value: data.haproxyHttpsPort,
          isEncrypted: false,
        });
      }

      const allSettings = [...systemSettingsToSave, ...haproxySettingsToSave];

      const promises = allSettings.map(
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
      refetchHAProxySettings();
    } catch (error) {
      console.error("Failed to save system settings:", error);
      toastWithCopy.error("Failed to save system settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDefaultContainerChange = async (containerName: string) => {
    setDefaultContainer(containerName);
    setIsSavingDefaultContainer(true);

    try {
      const existingSetting = defaultContainerData?.data?.[0];

      if (existingSetting) {
        await updateSetting.mutateAsync({
          id: existingSetting.id,
          setting: { value: containerName },
        });
      } else {
        await createSetting.mutateAsync({
          category: "system",
          key: "default_postgres_backup_container",
          value: containerName,
          isEncrypted: false,
        });
      }

      toastWithCopy.success("Default backup container updated successfully");
    } catch (error) {
      console.error("Failed to save default container:", error);
      toastWithCopy.error("Failed to save default container");
    } finally {
      setIsSavingDefaultContainer(false);
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

          {(settingsLoading || haproxyLoading) ? (
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

                {/* HAProxy Port Configuration */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconSettings className="h-5 w-5" />
                      <span>HAProxy Port Configuration</span>
                    </CardTitle>
                    <CardDescription>
                      Configure custom port mappings for HAProxy load balancer (optional)
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-md bg-muted p-4 space-y-2">
                      <h4 className="text-sm font-medium">Default Port Behavior</h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li>• <strong>Local network</strong> environments: Ports 80 (HTTP) and 443 (HTTPS)</li>
                        <li>• <strong>Internet</strong> environments: Ports 8111 (HTTP) and 8443 (HTTPS)</li>
                      </ul>
                      <p className="text-sm text-muted-foreground mt-2">
                        Override these defaults by specifying custom ports below. Leave empty to use network type defaults.
                      </p>
                    </div>

                    <FormField
                      control={form.control}
                      name="haproxyHttpPort"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>HTTP Port (Optional)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="Leave empty for default (80 or 8111)"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Custom port for HTTP traffic (1-65535). Overrides network type default.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="haproxyHttpsPort"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>HTTPS Port (Optional)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="Leave empty for default (443 or 8443)"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Custom port for HTTPS traffic (1-65535). Overrides network type default.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Alert>
                      <IconAlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        Port overrides apply to all HAProxy deployments. Ensure chosen ports are available on the host system.
                      </AlertDescription>
                    </Alert>
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

                {/* Default Postgres Backup Container */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <IconDatabase className="h-5 w-5" />
                      <span>Default Postgres Backup Container</span>
                    </CardTitle>
                    <CardDescription>
                      Select a default Azure Storage container for PostgreSQL database
                      backups. This container will be pre-selected when setting up new
                      backup configurations.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {defaultContainerLoading ? (
                      <Skeleton className="h-9 w-full" />
                    ) : (
                      <AzureContainerSelector
                        value={defaultContainer}
                        onChange={handleDefaultContainerChange}
                        disabled={isSavingDefaultContainer}
                        placeholder="Select default backup container..."
                      />
                    )}
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
    </div>
  );
}
