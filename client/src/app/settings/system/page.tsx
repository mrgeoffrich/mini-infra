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
  TestTube,
  Network,
  Route,
  Play,
  Trash2,
  CheckCircle,
  XCircle,
  Clock,
} from "lucide-react";
import { toastWithCopy } from "@/lib/toast-utils";
import { SystemSettingsInfo } from "@mini-infra/types";
import { useTestDockerRegistry } from "@/hooks/use-system-settings";
import {
  useDeployInfrastructure,
  useInfrastructureStatus,
  useCleanupInfrastructure,
} from "@/hooks/use-deployment-infrastructure";

// System settings schema
const systemSettingsSchema = z.object({
  // Backup container settings
  backupDockerImage: z
    .string()
    .min(1, "Backup Docker image is required")
    .regex(
      /^[\w\-./]+(?::\w+[\w\-.]*)?$/,
      "Invalid Docker image format (e.g., postgres:15-alpine, myregistry/postgres:latest)",
    ),
  backupRegistryUsername: z.string().optional(),
  backupRegistryPassword: z.string().optional(),

  // Restore container settings
  restoreDockerImage: z
    .string()
    .min(1, "Restore Docker image is required")
    .regex(
      /^[\w\-./]+(?::\w+[\w\-.]*)?$/,
      "Invalid Docker image format (e.g., postgres:15-alpine, myregistry/postgres:latest)",
    ),
  restoreRegistryUsername: z.string().optional(),
  restoreRegistryPassword: z.string().optional(),

  // Docker Network settings
  dockerNetworkName: z
    .string()
    .min(1, "Docker network name is required")
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
      "Invalid network name format (alphanumeric, underscores, dots, and hyphens)",
    ),
  dockerNetworkDriver: z.enum(["bridge", "overlay", "host", "none"]),

  // Traefik container settings
  traefikDockerImage: z
    .string()
    .min(1, "Traefik Docker image is required")
    .regex(
      /^[\w\-./]+(?::\w+[\w\-.]*)?$/,
      "Invalid Docker image format (e.g., traefik:v3.0, myregistry/traefik:latest)",
    ),
  traefikWebPort: z
    .string()
    .regex(/^\d+$/, "Port must be a number")
    .refine((val) => {
      const num = parseInt(val);
      return num >= 1 && num <= 65535;
    }, "Port must be between 1 and 65535"),
  traefikDashboardPort: z
    .string()
    .regex(/^\d+$/, "Port must be a number")
    .refine((val) => {
      const num = parseInt(val);
      return num >= 1 && num <= 65535;
    }, "Port must be between 1 and 65535"),
  traefikConfigYaml: z.string().min(1, "Traefik configuration is required"),
});

type SystemSettingsFormData = z.infer<typeof systemSettingsSchema>;

// Default Docker images and settings
const DEFAULT_BACKUP_IMAGE = "postgres:15-alpine";
const DEFAULT_RESTORE_IMAGE = "postgres:15-alpine";
const DEFAULT_NETWORK_NAME = "mini-infra-network";
const DEFAULT_TRAEFIK_IMAGE = "traefik:v3.0";
const DEFAULT_TRAEFIK_WEB_PORT = "80";
const DEFAULT_TRAEFIK_DASHBOARD_PORT = "8080";
const DEFAULT_TRAEFIK_CONFIG = `# Traefik Configuration
api:
  dashboard: true
  debug: true

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: "mini-infra-network"

certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@example.com
      storage: acme.json
      httpChallenge:
        entryPoint: web`;

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );
  const [showBackupPassword, setShowBackupPassword] = useState(false);
  const [showRestorePassword, setShowRestorePassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testingBackup, setTestingBackup] = useState(false);
  const [testingRestore, setTestingRestore] = useState(false);
  const [deployingInfrastructure, setDeployingInfrastructure] = useState(false);

  // Fetch existing system settings for dockerexecutor category
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
  const testDockerRegistry = useTestDockerRegistry();

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
      dockerNetworkName: DEFAULT_NETWORK_NAME,
      dockerNetworkDriver: "bridge",
      traefikDockerImage: DEFAULT_TRAEFIK_IMAGE,
      traefikWebPort: DEFAULT_TRAEFIK_WEB_PORT,
      traefikDashboardPort: DEFAULT_TRAEFIK_DASHBOARD_PORT,
      traefikConfigYaml: DEFAULT_TRAEFIK_CONFIG,
    },
    mode: "onChange",
  });

  // Infrastructure deployment hooks
  const deployInfrastructure = useDeployInfrastructure();
  const cleanupInfrastructure = useCleanupInfrastructure();

  // Get current network name for status monitoring
  const currentNetworkName =
    form.watch("dockerNetworkName") || DEFAULT_NETWORK_NAME;
  const { data: infrastructureStatus, refetch: refetchInfrastructureStatus } =
    useInfrastructureStatus(currentNetworkName, !!currentNetworkName);

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
      form.setValue(
        "dockerNetworkName",
        settingsMap.docker_network_name?.value || DEFAULT_NETWORK_NAME,
      );
      form.setValue(
        "dockerNetworkDriver",
        (settingsMap.docker_network_driver?.value as
          | "bridge"
          | "overlay"
          | "host"
          | "none") || "bridge",
      );
      form.setValue(
        "traefikDockerImage",
        settingsMap.traefik_docker_image?.value || DEFAULT_TRAEFIK_IMAGE,
      );
      form.setValue(
        "traefikWebPort",
        settingsMap.traefik_web_port?.value || DEFAULT_TRAEFIK_WEB_PORT,
      );
      form.setValue(
        "traefikDashboardPort",
        settingsMap.traefik_dashboard_port?.value ||
          DEFAULT_TRAEFIK_DASHBOARD_PORT,
      );
      form.setValue(
        "traefikConfigYaml",
        settingsMap.traefik_config_yaml?.value || DEFAULT_TRAEFIK_CONFIG,
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
        {
          key: "docker_network_name",
          value: data.dockerNetworkName,
          isEncrypted: false,
        },
        {
          key: "docker_network_driver",
          value: data.dockerNetworkDriver,
          isEncrypted: false,
        },
        {
          key: "traefik_docker_image",
          value: data.traefikDockerImage,
          isEncrypted: false,
        },
        {
          key: "traefik_web_port",
          value: data.traefikWebPort,
          isEncrypted: false,
        },
        {
          key: "traefik_dashboard_port",
          value: data.traefikDashboardPort,
          isEncrypted: false,
        },
        {
          key: "traefik_config_yaml",
          value: data.traefikConfigYaml,
          isEncrypted: false,
        },
      ];

      const promises = settingsToSave.map(
        async ({ key, value, isEncrypted }) => {
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
              category: "system",
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

  const handleTestDockerRegistry = async (type: "backup" | "restore") => {
    const isBackup = type === "backup";
    const setter = isBackup ? setTestingBackup : setTestingRestore;

    setter(true);
    try {
      const formValues = form.getValues();

      const testData = {
        type,
        image: isBackup
          ? formValues.backupDockerImage
          : formValues.restoreDockerImage,
        registryUsername: isBackup
          ? formValues.backupRegistryUsername
          : formValues.restoreRegistryUsername,
        registryPassword: isBackup
          ? formValues.backupRegistryPassword
          : formValues.restoreRegistryPassword,
      };

      const result = await testDockerRegistry.mutateAsync(testData);

      const successMessage = `${result.message} - Image: ${result.details.image}${result.details.pullTimeMs ? ` (${result.details.pullTimeMs}ms)` : ""}`;
      toastWithCopy.success(successMessage, {
        title: "Registry Connection Successful",
        description: `Image pulled successfully in ${result.details.pullTimeMs || 0}ms`,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to test Docker registry connection";
      toastWithCopy.error(errorMessage, {
        title: "Registry Connection Failed",
        description: "Copy the error details for troubleshooting",
      });
    } finally {
      setter(false);
    }
  };

  const handleDeployInfrastructure = async () => {
    setDeployingInfrastructure(true);
    try {
      const formValues = form.getValues();

      const result = await deployInfrastructure.mutateAsync({
        networkName: formValues.dockerNetworkName,
        networkDriver: formValues.dockerNetworkDriver,
        traefikImage: formValues.traefikDockerImage,
        webPort: parseInt(formValues.traefikWebPort),
        dashboardPort: parseInt(formValues.traefikDashboardPort),
        configYaml: formValues.traefikConfigYaml,
      });

      const deploymentMessage = `Infrastructure deployed successfully! Network: ${result.data.network.name}, Traefik: ${result.data.traefik.image}`;
      toastWithCopy.success(deploymentMessage, {
        title: "Infrastructure Deployment Complete",
        description: "Copy deployment details for your records",
      });

      // Refresh infrastructure status
      refetchInfrastructureStatus();
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to deploy infrastructure";
      toastWithCopy.error(errorMessage, {
        title: "Infrastructure Deployment Failed",
        description: "Copy the error details for troubleshooting",
      });
    } finally {
      setDeployingInfrastructure(false);
    }
  };

  const handleCleanupInfrastructure = async () => {
    try {
      const formValues = form.getValues();

      await cleanupInfrastructure.mutateAsync({
        networkName: formValues.dockerNetworkName,
      });

      toastWithCopy.success("Infrastructure cleaned up successfully");

      // Refresh infrastructure status
      refetchInfrastructureStatus();
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to cleanup infrastructure";
      toastWithCopy.error(errorMessage, {
        title: "Infrastructure Cleanup Failed",
        description: "Copy the error details for troubleshooting",
      });
    }
  };

  if (settingsError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center space-x-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/connectivity/overview">
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
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
            <Settings className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">System Settings</h1>
            <p className="text-muted-foreground">
              Configure system-wide settings for backup and restore operations
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        <div className="grid gap-6">
          {/* Description */}
          <div className="space-y-2">
            <p className="text-muted-foreground">
              These settings control Docker containers, networks, and Traefik
              load balancer for deployment operations.
            </p>
          </div>

          {settingsLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(handleSubmit)}
                className="space-y-6"
              >
                {/* Backup Container Settings */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <Container className="h-5 w-5" />
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

                    <FormField
                      control={form.control}
                      name="backupRegistryUsername"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Registry Username (Optional)</FormLabel>
                          <FormControl>
                            <Input placeholder="username" {...field} />
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
                                onClick={() =>
                                  setShowBackupPassword(!showBackupPassword)
                                }
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
                            Password for private Docker registry authentication
                            (encrypted when stored)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Test Connection Button */}
                    <div className="pt-4 border-t">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestDockerRegistry("backup")}
                        disabled={
                          testingBackup || !form.watch("backupDockerImage")
                        }
                        className="w-full"
                      >
                        {testingBackup ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Testing Connection...
                          </>
                        ) : (
                          <>
                            <TestTube className="h-4 w-4 mr-2" />
                            Test Connection
                          </>
                        )}
                      </Button>
                    </div>
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

                    <FormField
                      control={form.control}
                      name="restoreRegistryUsername"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Registry Username (Optional)</FormLabel>
                          <FormControl>
                            <Input placeholder="username" {...field} />
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
                                onClick={() =>
                                  setShowRestorePassword(!showRestorePassword)
                                }
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
                            Password for private Docker registry authentication
                            (encrypted when stored)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Test Connection Button */}
                    <div className="pt-4 border-t">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestDockerRegistry("restore")}
                        disabled={
                          testingRestore || !form.watch("restoreDockerImage")
                        }
                        className="w-full"
                      >
                        {testingRestore ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Testing Connection...
                          </>
                        ) : (
                          <>
                            <TestTube className="h-4 w-4 mr-2" />
                            Test Connection
                          </>
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* Docker Network Settings */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <Network className="h-5 w-5" />
                      <span>Docker Network Settings</span>
                    </CardTitle>
                    <CardDescription>
                      Configure the Docker network used for deployment
                      containers
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="dockerNetworkName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Network Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="mini-infra-network"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Name of the Docker network for deployment containers
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="dockerNetworkDriver"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Network Driver</FormLabel>
                          <FormControl>
                            <select
                              {...field}
                              className="w-full h-10 px-3 py-2 text-sm bg-background border border-input rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            >
                              <option value="bridge">Bridge</option>
                              <option value="overlay">Overlay</option>
                              <option value="host">Host</option>
                              <option value="none">None</option>
                            </select>
                          </FormControl>
                          <FormDescription>
                            Docker network driver type
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                {/* Traefik Container Settings */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <Route className="h-5 w-5" />
                      <span>Traefik Load Balancer Settings</span>
                    </CardTitle>
                    <CardDescription>
                      Configure the Traefik container for zero-downtime
                      deployments
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="traefikDockerImage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Traefik Docker Image</FormLabel>
                          <FormControl>
                            <Input placeholder="traefik:v3.0" {...field} />
                          </FormControl>
                          <FormDescription>
                            Docker image for Traefik load balancer (e.g.,
                            traefik:v3.0, traefik:latest)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="traefikWebPort"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Web Port</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                placeholder="80"
                                min="1"
                                max="65535"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              HTTP port for web traffic
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="traefikDashboardPort"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Dashboard Port</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                placeholder="8080"
                                min="1"
                                max="65535"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              Port for Traefik dashboard
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="traefikConfigYaml"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Traefik Configuration (YAML)</FormLabel>
                          <FormControl>
                            <textarea
                              {...field}
                              className="w-full h-64 px-3 py-2 text-sm bg-background border border-input rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 font-mono"
                              placeholder="Enter Traefik configuration in YAML format..."
                            />
                          </FormControl>
                          <FormDescription>
                            Complete Traefik configuration in YAML format
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                {/* Infrastructure Status and Management */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <Settings className="h-5 w-5" />
                      <span>Infrastructure Management</span>
                    </CardTitle>
                    <CardDescription>
                      Deploy and manage the Docker network and Traefik container
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {/* Infrastructure Status */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between p-4 border rounded-lg">
                        <div className="flex items-center space-x-3">
                          <Network className="h-5 w-5 text-blue-500" />
                          <div>
                            <h4 className="font-medium">Docker Network</h4>
                            <p className="text-sm text-muted-foreground">
                              {currentNetworkName}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          {infrastructureStatus?.data.networkStatus.exists ? (
                            <>
                              <CheckCircle className="h-5 w-5 text-green-500" />
                              <span className="text-sm text-green-600">
                                Active
                              </span>
                            </>
                          ) : (
                            <>
                              <XCircle className="h-5 w-5 text-red-500" />
                              <span className="text-sm text-red-600">
                                Not Found
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between p-4 border rounded-lg">
                        <div className="flex items-center space-x-3">
                          <Route className="h-5 w-5 text-purple-500" />
                          <div>
                            <h4 className="font-medium">
                              Traefik Load Balancer
                            </h4>
                            <p className="text-sm text-muted-foreground">
                              Ports: {form.watch("traefikWebPort")}:
                              {form.watch("traefikDashboardPort")}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          {infrastructureStatus?.data.traefikStatus.exists ? (
                            infrastructureStatus.data.traefikStatus.running ? (
                              <>
                                <CheckCircle className="h-5 w-5 text-green-500" />
                                <span className="text-sm text-green-600">
                                  Running
                                </span>
                              </>
                            ) : (
                              <>
                                <Clock className="h-5 w-5 text-yellow-500" />
                                <span className="text-sm text-yellow-600">
                                  Stopped
                                </span>
                              </>
                            )
                          ) : (
                            <>
                              <XCircle className="h-5 w-5 text-red-500" />
                              <span className="text-sm text-red-600">
                                Not Found
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Infrastructure Actions */}
                    <div className="flex space-x-3 pt-4 border-t">
                      <Button
                        type="button"
                        variant="default"
                        onClick={handleDeployInfrastructure}
                        disabled={
                          deployingInfrastructure || !form.formState.isValid
                        }
                        className="flex-1"
                      >
                        {deployingInfrastructure ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Deploying...
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4 mr-2" />
                            Deploy Infrastructure
                          </>
                        )}
                      </Button>

                      <Button
                        type="button"
                        variant="destructive"
                        onClick={handleCleanupInfrastructure}
                        disabled={
                          cleanupInfrastructure.isPending ||
                          (!infrastructureStatus?.data.networkStatus.exists &&
                            !infrastructureStatus?.data.traefikStatus.exists)
                        }
                      >
                        {cleanupInfrastructure.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Cleaning...
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Cleanup
                          </>
                        )}
                      </Button>
                    </div>

                    {/* Help Text */}
                    <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                      <p className="font-medium mb-1">
                        Deployment Information:
                      </p>
                      <ul className="space-y-1 text-xs">
                        <li>
                          • Save settings first, then deploy infrastructure
                        </li>
                        <li>
                          • Network will be created automatically if it doesn't
                          exist
                        </li>
                        <li>
                          • Traefik dashboard will be available at
                          http://localhost:{form.watch("traefikDashboardPort")}
                        </li>
                        <li>
                          • Web traffic will be routed through port{" "}
                          {form.watch("traefikWebPort")}
                        </li>
                      </ul>
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
    </div>
  );
}
