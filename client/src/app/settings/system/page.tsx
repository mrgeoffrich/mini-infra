import { useState, useEffect } from "react";
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
import {
  useSystemSettings,
  useCreateSystemSetting,
  useUpdateSystemSetting,
} from "@/hooks/use-settings";
import {
  AlertCircle,
  ArrowLeft,
  Save,
  Loader2,
  Settings,
  Eye,
  EyeOff,
  Container,
} from "lucide-react";
import { toast } from "sonner";
import { SystemSettingsInfo } from "@mini-infra/types";

// System settings schema
const systemSettingsSchema = z.object({
  // Backup container settings
  backupDockerImage: z
    .string()
    .min(1, "Backup Docker image is required")
    .regex(
      /^[\w\-\.\/]+(?::\w+[\w\-\.]*)?$/,
      "Invalid Docker image format (e.g., postgres:15-alpine, myregistry/postgres:latest)",
    ),
  backupRegistryUsername: z.string().optional(),
  backupRegistryPassword: z.string().optional(),
  
  // Restore container settings
  restoreDockerImage: z
    .string()
    .min(1, "Restore Docker image is required")
    .regex(
      /^[\w\-\.\/]+(?::\w+[\w\-\.]*)?$/,
      "Invalid Docker image format (e.g., postgres:15-alpine, myregistry/postgres:latest)",
    ),
  restoreRegistryUsername: z.string().optional(),
  restoreRegistryPassword: z.string().optional(),
});

type SystemSettingsFormData = z.infer<typeof systemSettingsSchema>;

// Default Docker images
const DEFAULT_BACKUP_IMAGE = "postgres:15-alpine";
const DEFAULT_RESTORE_IMAGE = "postgres:15-alpine";

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );
  const [showBackupPassword, setShowBackupPassword] = useState(false);
  const [showRestorePassword, setShowRestorePassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch existing system settings for dockerexecutor category
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings,
  } = useSystemSettings({
    filters: { category: "system" as any, isActive: true },
    limit: 50,
  });

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<SystemSettingsFormData>({
    resolver: zodResolver(systemSettingsSchema),
    defaultValues: {
      backupDockerImage: DEFAULT_BACKUP_IMAGE,
      backupRegistryUsername: "",
      backupRegistryPassword: "",
      restoreDockerImage: DEFAULT_RESTORE_IMAGE,
      restoreRegistryUsername: "",
      restoreRegistryPassword: "",
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
        "backupDockerImage",
        settingsMap.backup_docker_image?.value || DEFAULT_BACKUP_IMAGE,
      );
      form.setValue(
        "backupRegistryUsername",
        settingsMap.backup_registry_username?.value || "",
      );
      form.setValue(
        "backupRegistryPassword",
        settingsMap.backup_registry_password?.value || "",
      );
      form.setValue(
        "restoreDockerImage",
        settingsMap.restore_docker_image?.value || DEFAULT_RESTORE_IMAGE,
      );
      form.setValue(
        "restoreRegistryUsername",
        settingsMap.restore_registry_username?.value || "",
      );
      form.setValue(
        "restoreRegistryPassword",
        settingsMap.restore_registry_password?.value || "",
      );
    }
  }, [settingsData, form]);

  const handleSubmit = async (data: SystemSettingsFormData) => {
    setIsSaving(true);
    try {
      const settingsToSave = [
        {
          key: "backup_docker_image",
          value: data.backupDockerImage,
          isEncrypted: false,
        },
        {
          key: "backup_registry_username",
          value: data.backupRegistryUsername || "",
          isEncrypted: false,
        },
        {
          key: "backup_registry_password",
          value: data.backupRegistryPassword || "",
          isEncrypted: true,
        },
        {
          key: "restore_docker_image",
          value: data.restoreDockerImage,
          isEncrypted: false,
        },
        {
          key: "restore_registry_username",
          value: data.restoreRegistryUsername || "",
          isEncrypted: false,
        },
        {
          key: "restore_registry_password",
          value: data.restoreRegistryPassword || "",
          isEncrypted: true,
        },
      ];

      const promises = settingsToSave.map(async ({ key, value, isEncrypted }) => {
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
            category: "system" as any,
            key,
            value,
            isEncrypted,
          });
        }
      });

      await Promise.all(promises);

      toast.success("System settings saved successfully");
      
      // Refetch settings to get updated data
      refetchSettings();
    } catch (error) {
      console.error("Failed to save system settings:", error);
      toast.error("Failed to save system settings");
    } finally {
      setIsSaving(false);
    }
  };

  if (settingsError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center space-x-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/settings/overview">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">System Settings</h1>
        </div>

        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load system settings. Please try refreshing the page.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center space-x-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings/overview">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <Settings className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">System Settings</h1>
      </div>

      <div className="space-y-6">
        {/* Description */}
        <div className="space-y-2">
          <p className="text-muted-foreground">
            Configure system-wide settings for backup and restore operations. These settings
            control the Docker containers used for PostgreSQL database operations.
          </p>
        </div>

        {settingsLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
              {/* Backup Container Settings */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Container className="h-5 w-5" />
                    <span>Backup Container Settings</span>
                  </CardTitle>
                  <CardDescription>
                    Configure the Docker container used for database backup operations
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
                          Docker image for backup operations (e.g., postgres:15-alpine, myregistry/postgres:latest)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="backupRegistryUsername"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Registry Username (Optional)</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="username"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Username for private Docker registry authentication
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="backupRegistryPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Registry Password (Optional)</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type={showBackupPassword ? "text" : "password"}
                              placeholder="password"
                              {...field}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-0 top-0 h-full px-3"
                              onClick={() => setShowBackupPassword(!showBackupPassword)}
                            >
                              {showBackupPassword ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </FormControl>
                        <FormDescription>
                          Password for private Docker registry authentication (encrypted when stored)
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
                    <Container className="h-5 w-5" />
                    <span>Restore Container Settings</span>
                  </CardTitle>
                  <CardDescription>
                    Configure the Docker container used for database restore operations
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
                          Docker image for restore operations (e.g., postgres:15-alpine, myregistry/postgres:latest)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="restoreRegistryUsername"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Registry Username (Optional)</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="username"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Username for private Docker registry authentication
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="restoreRegistryPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Registry Password (Optional)</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type={showRestorePassword ? "text" : "password"}
                              placeholder="password"
                              {...field}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-0 top-0 h-full px-3"
                              onClick={() => setShowRestorePassword(!showRestorePassword)}
                            >
                              {showRestorePassword ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </FormControl>
                        <FormDescription>
                          Password for private Docker registry authentication (encrypted when stored)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
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
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
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
  );
}