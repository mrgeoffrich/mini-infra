import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useSystemSettings,
  useCreateSystemSetting,
  useUpdateSystemSetting,
} from "@/hooks/use-settings";
import { useValidateService } from "@/hooks/use-settings-validation";
import {
  IconBrandDocker,
  IconCircleCheck,
  IconCircleX,
  IconAlertCircle,
  IconLoader2,
  IconBolt,
  IconHelp,
  IconActivity,
  IconPlayerPlay,
  IconPlayerStop,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { SystemSettingsInfo } from "@mini-infra/types";
import { useMonitoringStatus, useStartMonitoring, useStopMonitoring } from "@/hooks/use-monitoring";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";

// Docker settings schema
const dockerSettingsSchema = z.object({
  dockerHostIp: z
    .string()
    .min(1, "Docker Host IP is required")
    .regex(
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
      "Must be a valid IPv4 address (e.g., 192.168.1.100)"
    ),
  host: z
    .string()
    .min(1, "Docker host is required")
    .refine(
      (host) =>
        host.startsWith("unix://") ||
        host.startsWith("npipe://") ||
        host.startsWith("tcp://") ||
        host.startsWith("http://") ||
        host.startsWith("https://"),
      "Docker host must be a valid URL (unix://, npipe://, tcp://, http://, or https://)",
    ),
  version: z
    .string()
    .min(1, "Docker API version is required")
    .regex(/^\d+\.\d+$/, "API version must be in format X.Y (e.g., 1.41)"),
});

type DockerSettingsFormData = z.infer<typeof dockerSettingsSchema>;

export default function DockerSettingsPage() {
  const queryClient = useQueryClient();
  const [validationState, setValidationState] = useState<{
    isValidating: boolean;
    isSuccess: boolean;
    error: string | null;
  }>({ isValidating: false, isSuccess: false, error: null });
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );

  // Fetch existing Docker settings
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
  } = useSystemSettings({
    filters: { category: "docker", isActive: true },
    limit: 50,
  });

  // Fetch Docker Host IP from system settings
  const {
    data: systemSettingsData,
    isLoading: systemSettingsLoading,
    error: systemSettingsError,
  } = useSystemSettings({
    filters: { category: "system", isActive: true },
    limit: 50,
  });

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<DockerSettingsFormData>({
    resolver: zodResolver(dockerSettingsSchema),
    defaultValues: {
      dockerHostIp: "",
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
      version: "1.51",
    },
    mode: "onChange",
  });

  // Validation service
  const validateService = useValidateService();

  // Update form when settings are loaded
  useEffect(() => {
    const settingsMap: Record<string, SystemSettingsInfo> = {};

    // Merge docker settings
    if (settingsData?.data) {
      settingsData.data.forEach(setting => {
        settingsMap[setting.key] = setting;
      });
    }

    // Merge system settings
    if (systemSettingsData?.data) {
      systemSettingsData.data.forEach(setting => {
        settingsMap[setting.key] = setting;
      });
    }

    setSettings(settingsMap);

    // Update form with current values
    if (settingsMap.docker_host_ip?.value) {
      form.setValue("dockerHostIp", settingsMap.docker_host_ip.value);
    }
    if (settingsMap.host?.value) {
      form.setValue("host", settingsMap.host.value);
    }
    if (settingsMap.apiVersion?.value) {
      form.setValue("version", settingsMap.apiVersion.value);
    }
  }, [settingsData, systemSettingsData, form]);

  const handleValidateAndSave = async (data: DockerSettingsFormData) => {
    setValidationState({ isValidating: true, isSuccess: false, error: null });

    try {
      // Step 1: Validate the connection settings
      const validationResult = await validateService.mutateAsync({
        service: "docker",
        settings: { host: data.host, version: data.version },
      });

      if (!validationResult.data.isValid) {
        throw new Error(validationResult.message || "Connection validation failed");
      }

      // Step 2: Save settings if validation passed
      const promises: Promise<unknown>[] = [];

      // Save or update Docker Host IP setting
      if (settings.docker_host_ip) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.docker_host_ip.id,
            setting: { value: data.dockerHostIp },
          }),
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "system",
            key: "docker_host_ip",
            value: data.dockerHostIp,
            isEncrypted: false,
          }),
        );
      }

      // Save or update host setting
      if (settings.host) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.host.id,
            setting: { value: data.host },
          }),
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "docker",
            key: "host",
            value: data.host,
            isEncrypted: false,
          }),
        );
      }

      // Save or update version setting
      if (settings.apiVersion) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.apiVersion.id,
            setting: { value: data.version },
          }),
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "docker",
            key: "apiVersion",
            value: data.version,
            isEncrypted: false,
          }),
        );
      }

      await Promise.all(promises);

      // Step 3: Force refresh connectivity status and show success feedback
      await queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
      setValidationState({ isValidating: false, isSuccess: true, error: null });
      toast.success("Docker connection validated and saved successfully");

      // Clear success message after 5 seconds
      setTimeout(() => {
        setValidationState(prev => ({ ...prev, isSuccess: false }));
      }, 5000);

    } catch (error) {
      const errorMessage = (error as Error).message;
      setValidationState({ isValidating: false, isSuccess: false, error: errorMessage });
      toast.error(`Failed to validate and save: ${errorMessage}`);
    }
  };

  const isSaving = createSetting.isPending || updateSetting.isPending || validationState.isValidating;
  const isLoading = settingsLoading || systemSettingsLoading;
  const hasError = settingsError || systemSettingsError;

  if (hasError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconBrandDocker className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Docker Configuration</h1>
              <p className="text-muted-foreground">
                Configure Docker host connection settings
              </p>
            </div>
          </div>

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load settings: {settingsError?.message || systemSettingsError?.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconBrandDocker className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Docker Configuration</h1>
            <p className="text-muted-foreground">
              Configure Docker host connection settings for container management
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-4xl">
        {/* Docker Host Network Configuration Card */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Docker Host Network Configuration</CardTitle>
            <CardDescription>
              Configure the IP address of your Docker host for DNS record creation
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-20" />
              </div>
            ) : (
              <Form {...form}>
                <form className="space-y-6">
                  <FormField
                    control={form.control}
                    name="dockerHostIp"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center gap-2">
                          <FormLabel>Docker Host IP Address</FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                              >
                                <IconHelp className="h-4 w-4" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80">
                              <div className="space-y-3">
                                <div className="flex items-center gap-2">
                                  <IconBolt className="h-4 w-4" />
                                  <span className="font-medium text-sm">
                                    What is this for?
                                  </span>
                                </div>
                                <div className="text-sm space-y-2">
                                  <p>
                                    This is the IP address of the Docker host where your
                                    containers are running. It's used for creating DNS A
                                    records in Cloudflare that point to your services.
                                  </p>
                                  <div>
                                    <strong>Examples:</strong>
                                    <div className="mt-1 space-y-1">
                                      <div>
                                        Local network:{" "}
                                        <code className="text-xs bg-muted px-1 rounded">
                                          192.168.1.100
                                        </code>
                                      </div>
                                      <div>
                                        Public IP:{" "}
                                        <code className="text-xs bg-muted px-1 rounded">
                                          203.0.113.1
                                        </code>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </div>
                        <FormControl>
                          <Input
                            placeholder="e.g., 192.168.1.100 or 203.0.113.1"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Required. Must be a valid IPv4 address. This IP will be used
                          when creating DNS records for your deployed containers.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </form>
              </Form>
            )}
          </CardContent>
        </Card>

        {/* Configuration Form */}
        <Card>
              <CardHeader>
                <CardTitle>Connection Settings</CardTitle>
                <CardDescription>
                  Configure how Mini Infra connects to your Docker daemon. The
                  default Unix socket works for most local installations.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-4">
                    <Skeleton className="h-20" />
                    <Skeleton className="h-20" />
                    <Skeleton className="h-10" />
                  </div>
                ) : (
                  <Form {...form}>
                    <form
                      onSubmit={form.handleSubmit(handleValidateAndSave)}
                      className="space-y-6"
                    >
                      <FormField
                        control={form.control}
                        name="host"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center gap-2">
                              <FormLabel>Docker Host URL</FormLabel>
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0"
                                  >
                                    <IconHelp className="h-4 w-4" />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-80">
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <IconBolt className="h-4 w-4" />
                                      <span className="font-medium text-sm">
                                        Quick Tips
                                      </span>
                                    </div>
                                    <div className="text-sm space-y-2">
                                      <div>
                                        <strong>Local Docker:</strong>{" "}
                                        <code className="text-xs bg-muted px-1 rounded">
                                          unix:///var/run/docker.sock
                                        </code>
                                      </div>
                                      <div>
                                        <strong>Remote Docker:</strong>{" "}
                                        <code className="text-xs bg-muted px-1 rounded">
                                          tcp://host:2376
                                        </code>
                                      </div>
                                      <div>
                                        <strong>
                                          Windows (Docker Desktop):
                                        </strong>{" "}
                                        <code className="text-xs bg-muted px-1 rounded">
                                          npipe:////./pipe/dockerDesktopLinuxEngine
                                        </code>
                                      </div>
                                    </div>
                                  </div>
                                </PopoverContent>
                              </Popover>
                            </div>
                            <FormControl>
                              <Input
                                placeholder="unix:///var/run/docker.sock"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              The Docker daemon connection URL. Use unix:// for
                              local socket, tcp:// for remote connections, or
                              npipe:// for Windows named pipes.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="version"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center gap-2">
                              <FormLabel>Docker API Version</FormLabel>
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0"
                                  >
                                    <IconHelp className="h-4 w-4" />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-80">
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <IconBolt className="h-4 w-4" />
                                      <span className="font-medium text-sm">
                                        How to find API version
                                      </span>
                                    </div>
                                    <div className="text-sm space-y-2">
                                      <div>
                                        <strong>Get API version only:</strong>
                                        <code className="text-xs bg-muted px-1 rounded block mt-1">
                                          docker version --format '
                                          {"{{.Server.APIVersion}}"}'
                                        </code>
                                      </div>
                                      <div>
                                        <strong>Get all version info:</strong>
                                        <code className="text-xs bg-muted px-1 rounded block mt-1">
                                          docker version
                                        </code>
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        Run these commands in your terminal to
                                        find your Docker API version.
                                      </div>
                                    </div>
                                  </div>
                                </PopoverContent>
                              </Popover>
                            </div>
                            <FormControl>
                              <Input placeholder="1.41" {...field} />
                            </FormControl>
                            <FormDescription>
                              The Docker API version to use. Most installations
                              support version 1.41 or higher.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="flex gap-3">
                        <Button
                          type="submit"
                          disabled={!form.formState.isValid || isSaving}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          {isSaving ? (
                            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <IconCircleCheck className="mr-2 h-4 w-4" />
                          )}
                          Validate & Save
                        </Button>
                      </div>
                    </form>
                  </Form>
                )}
              </CardContent>
        </Card>

        {/* Validation Feedback */}
        {validationState.isSuccess && (
          <Alert className="bg-green-50 border-green-200 mt-6">
            <IconCircleCheck className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700">
              Docker connection has been validated and configured successfully.
              The system can now manage Docker containers and perform operations.
            </AlertDescription>
          </Alert>
        )}

        {validationState.error && (
          <Alert variant="destructive" className="mt-6">
            <IconCircleX className="h-4 w-4" />
            <AlertDescription>
              Validation failed: {validationState.error}
            </AlertDescription>
          </Alert>
        )}

        {/* Monitoring Service Card - shown after successful Docker connection */}
        {validationState.isSuccess && <MonitoringServiceCard />}
        {!validationState.isSuccess && !validationState.error && !isLoading && settings.host?.value && (
          <MonitoringServiceCard />
        )}
      </div>
    </div>
  );
}

function MonitoringServiceCard() {
  const navigate = useNavigate();
  const { data: monitoringStatus, isLoading } = useMonitoringStatus({ refetchInterval: 10000 });
  const startMonitoring = useStartMonitoring();
  const stopMonitoring = useStopMonitoring();

  const serviceStatus = monitoringStatus?.service?.status || "unknown";
  const isRunning = serviceStatus === "running";
  const isStopped = serviceStatus === "stopped" || serviceStatus === "failed" || !monitoringStatus?.service;

  const handleStart = async () => {
    try {
      await startMonitoring.mutateAsync();
      toast.success("Monitoring service started successfully");
    } catch (error) {
      toast.error(`Failed to start monitoring: ${(error as Error).message}`);
    }
  };

  const handleStop = async () => {
    try {
      await stopMonitoring.mutateAsync();
      toast.success("Monitoring service stopped");
    } catch (error) {
      toast.error(`Failed to stop monitoring: ${(error as Error).message}`);
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconActivity className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="flex items-center gap-2">
                Container Monitoring
                {!isLoading && (
                  <Badge
                    variant={isRunning ? "default" : "secondary"}
                    className={isRunning ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" : ""}
                  >
                    {serviceStatus}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Collect CPU, memory, and network metrics from all containers using Telegraf and Prometheus
              </CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          {isStopped && (
            <Button
              onClick={handleStart}
              disabled={startMonitoring.isPending}
              className="bg-green-600 hover:bg-green-700"
            >
              {startMonitoring.isPending ? (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <IconPlayerPlay className="mr-2 h-4 w-4" />
              )}
              Start Monitoring
            </Button>
          )}
          {isRunning && (
            <>
              <Button
                variant="outline"
                onClick={() => navigate("/monitoring")}
              >
                <IconActivity className="mr-2 h-4 w-4" />
                View Metrics
              </Button>
              <Button
                onClick={handleStop}
                disabled={stopMonitoring.isPending}
                variant="destructive"
              >
                {stopMonitoring.isPending ? (
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <IconPlayerStop className="mr-2 h-4 w-4" />
                )}
                Stop
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
