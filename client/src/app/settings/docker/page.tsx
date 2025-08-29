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
import { Badge } from "@/components/ui/badge";
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
import { useAdvancedSettingsValidation } from "@/hooks/use-settings-validation";
import {
  Container,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  ArrowLeft,
  Save,
  TestTube,
  Loader2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { SystemSettingsInfo } from "@mini-infra/types";

// Docker settings schema
const dockerSettingsSchema = z.object({
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

// Map connectivity status to UI elements
const STATUS_VARIANTS = {
  connected: {
    variant: "default" as const,
    icon: CheckCircle,
    color: "text-green-600",
    bgColor: "bg-green-50 border-green-200",
  },
  failed: {
    variant: "destructive" as const,
    icon: XCircle,
    color: "text-red-600",
    bgColor: "bg-red-50 border-red-200",
  },
  timeout: {
    variant: "secondary" as const,
    icon: Clock,
    color: "text-yellow-600",
    bgColor: "bg-yellow-50 border-yellow-200",
  },
  unreachable: {
    variant: "outline" as const,
    icon: AlertCircle,
    color: "text-gray-600",
    bgColor: "bg-gray-50 border-gray-200",
  },
} as const;

export default function DockerSettingsPage() {
  const [isTestingConnection, setIsTestingConnection] = useState(false);
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

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<DockerSettingsFormData>({
    resolver: zodResolver(dockerSettingsSchema),
    defaultValues: {
      host: "unix:///var/run/docker.sock",
      version: "1.41",
    },
    mode: "onChange",
  });

  // Watch form values for real-time validation
  const formValues = form.watch();
  const [debouncedValues, setDebouncedValues] = useState(formValues);

  // Debounce form values for validation
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValues(formValues);
    }, 500);
    return () => clearTimeout(timer);
  }, [formValues]);

  // Advanced validation with real-time connectivity testing
  const validation = useAdvancedSettingsValidation(
    "docker",
    form.formState.isValid ? debouncedValues : undefined,
    {
      enabled: form.formState.isValid,
      debounceDelay: 500,
      onValidationSuccess: () => {
        toast.success("Docker connection validated successfully");
      },
      onValidationError: (_, error) => {
        toast.error(`Docker validation failed: ${error.message}`);
      },
    },
  );

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
      if (settingsMap.host?.value) {
        form.setValue("host", settingsMap.host.value);
      }
      if (settingsMap.version?.value) {
        form.setValue("version", settingsMap.version.value);
      }
    }
  }, [settingsData, form]);

  const handleSave = async (data: DockerSettingsFormData) => {
    try {
      const promises: Promise<unknown>[] = [];

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
      if (settings.version) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.version.id,
            setting: { value: data.version },
          }),
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "docker",
            key: "version",
            value: data.version,
            isEncrypted: false,
          }),
        );
      }

      await Promise.all(promises);
      toast.success("Docker settings saved successfully");
    } catch (error) {
      toast.error(`Failed to save settings: ${(error as Error).message}`);
    }
  };

  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    try {
      await validation.validateManually();
    } finally {
      setIsTestingConnection(false);
    }
  };

  // Get latest connectivity status
  const latestConnectivity = validation.connectivity.data?.data?.[0];
  const StatusIcon = latestConnectivity
    ? STATUS_VARIANTS[latestConnectivity.status as keyof typeof STATUS_VARIANTS]
        ?.icon || AlertCircle
    : AlertCircle;
  const statusColor = latestConnectivity
    ? STATUS_VARIANTS[latestConnectivity.status as keyof typeof STATUS_VARIANTS]
        ?.color || "text-gray-600"
    : "text-gray-600";
  const statusBg = latestConnectivity
    ? STATUS_VARIANTS[latestConnectivity.status as keyof typeof STATUS_VARIANTS]
        ?.bgColor || "bg-gray-50 border-gray-200"
    : "bg-gray-50 border-gray-200";

  const isLoading = settingsLoading || validation.isValidating;
  const isSaving = createSetting.isPending || updateSetting.isPending;

  if (settingsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/settings/overview">
                <ArrowLeft className="h-4 w-4" />
                Back to Settings
              </Link>
            </Button>
          </div>
          <h1 className="text-3xl font-bold mb-2">Docker Configuration</h1>
          <p className="text-muted-foreground">
            Configure Docker host connection settings
          </p>
        </div>
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load Docker settings: {settingsError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/settings/overview">
              <ArrowLeft className="h-4 w-4" />
              Back to Settings
            </Link>
          </Button>
        </div>
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <Container className="h-6 w-6" />
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
        <div className="grid gap-6 md:grid-cols-3">
          {/* Configuration Form */}
          <div className="md:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Connection Settings</CardTitle>
                <CardDescription>
                  Configure how Mini Infra connects to your Docker daemon. The
                  default Unix socket works for most local installations.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {settingsLoading ? (
                  <div className="space-y-4">
                    <Skeleton className="h-20" />
                    <Skeleton className="h-20" />
                    <Skeleton className="h-10" />
                  </div>
                ) : (
                  <Form {...form}>
                    <form
                      onSubmit={form.handleSubmit(handleSave)}
                      className="space-y-6"
                    >
                      <FormField
                        control={form.control}
                        name="host"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Docker Host URL</FormLabel>
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
                            <FormLabel>Docker API Version</FormLabel>
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
                        >
                          {isSaving ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="mr-2 h-4 w-4" />
                          )}
                          Save Settings
                        </Button>

                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            !form.formState.isValid ||
                            isTestingConnection ||
                            validation.isValidating
                          }
                          onClick={handleTestConnection}
                        >
                          {isTestingConnection || validation.isValidating ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <TestTube className="mr-2 h-4 w-4" />
                          )}
                          Test Connection
                        </Button>
                      </div>
                    </form>
                  </Form>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Status Panel */}
          <div className="space-y-6">
            {/* Connection Status */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Connection Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading && !latestConnectivity ? (
                  <Skeleton className="h-20" />
                ) : latestConnectivity ? (
                  <div className={`p-4 rounded-md border ${statusBg}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <StatusIcon className={`h-5 w-5 ${statusColor}`} />
                      <Badge
                        variant={
                          STATUS_VARIANTS[
                            latestConnectivity.status as keyof typeof STATUS_VARIANTS
                          ]?.variant || "outline"
                        }
                      >
                        {latestConnectivity.status}
                      </Badge>
                    </div>
                    {latestConnectivity.responseTimeMs && (
                      <div className="text-sm text-muted-foreground mb-1">
                        Response time: {latestConnectivity.responseTimeMs}ms
                      </div>
                    )}
                    {latestConnectivity.lastSuccessfulAt && (
                      <div className="text-sm text-muted-foreground mb-1">
                        Last successful:{" "}
                        {new Date(
                          latestConnectivity.lastSuccessfulAt,
                        ).toLocaleString()}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      Checked:{" "}
                      {new Date(latestConnectivity.checkedAt).toLocaleString()}
                    </div>
                    {latestConnectivity.errorMessage && (
                      <div className="text-sm text-red-600 mt-2">
                        {latestConnectivity.errorMessage}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-4 rounded-md border bg-gray-50 border-gray-200">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertCircle className="h-5 w-5 text-gray-600" />
                      <Badge variant="outline">Unknown</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      No connectivity checks performed yet
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Validation Status */}
            {(validation.validation.data ||
              validation.validation.isLoading) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium">
                    Real-time Validation
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {validation.validation.isLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm text-muted-foreground">
                        Validating configuration...
                      </span>
                    </div>
                  ) : validation.validation.data?.data.isValid ? (
                    <div className="flex items-center gap-2 text-green-600">
                      <CheckCircle className="h-4 w-4" />
                      <span className="text-sm font-medium">
                        Configuration is valid
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-red-600">
                      <XCircle className="h-4 w-4" />
                      <span className="text-sm font-medium">
                        Configuration has issues
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Quick Tips */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  <Zap className="inline mr-2 h-4 w-4" />
                  Quick Tips
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div>
                  <strong>Local Docker:</strong> Use{" "}
                  <code className="text-xs bg-muted px-1 rounded">
                    unix:///var/run/docker.sock
                  </code>
                </div>
                <div>
                  <strong>Remote Docker:</strong> Use{" "}
                  <code className="text-xs bg-muted px-1 rounded">
                    tcp://host:2376
                  </code>
                </div>
                <div>
                  <strong>Windows:</strong> Use{" "}
                  <code className="text-xs bg-muted px-1 rounded">
                    npipe:////./pipe/docker_engine
                  </code>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
