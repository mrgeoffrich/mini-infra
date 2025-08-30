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
  Database,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  ArrowLeft,
  Save,
  TestTube,
  Loader2,
  Zap,
  Eye,
  EyeOff,
  Shield,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import { SystemSettingsInfo } from "@mini-infra/types";
import { AzureContainerList } from "@/components/AzureContainerList";
import { AzureConnectivityStatus } from "@/components/AzureConnectivityStatus";

// Azure settings schema
const azureSettingsSchema = z.object({
  connectionString: z
    .string()
    .min(1, "Azure Storage connection string is required")
    .min(50, "Connection string appears to be too short")
    .refine(
      (val) =>
        val.includes("DefaultEndpointsProtocol=") &&
        val.includes("AccountName=") &&
        val.includes("AccountKey="),
      "Connection string must include DefaultEndpointsProtocol, AccountName, and AccountKey",
    ),
});

type AzureSettingsFormData = z.infer<typeof azureSettingsSchema>;

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

export default function AzureSettingsPage() {
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [showConnectionString, setShowConnectionString] = useState(false);
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );

  // Fetch existing Azure settings
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
  } = useSystemSettings({
    filters: { category: "azure", isActive: true },
    limit: 50,
  });

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<AzureSettingsFormData>({
    resolver: zodResolver(azureSettingsSchema),
    defaultValues: {
      connectionString: "",
    },
    mode: "onChange",
  });

  // Watch form values for real-time validation
  const formValues = form.watch();
  const [debouncedValues, setDebouncedValues] = useState(formValues);
  const [autoSaveStatus, setAutoSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  // Debounce form values for validation
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValues(formValues);
    }, 500);
    return () => clearTimeout(timer);
  }, [formValues]);

  // Auto-save functionality with debouncing
  useEffect(() => {
    if (!form.formState.isValid || !debouncedValues.connectionString) {
      return;
    }

    // Only auto-save if the connection string has actually changed from the saved value
    const currentSavedValue = settings.connection_string?.value || "";
    if (debouncedValues.connectionString === currentSavedValue) {
      return;
    }

    // Auto-save after debounce delay
    const autoSaveTimer = setTimeout(async () => {
      try {
        setAutoSaveStatus("saving");

        // Save or update connection string setting (encrypted)
        if (settings.connection_string) {
          await updateSetting.mutateAsync({
            id: settings.connection_string.id,
            setting: { value: debouncedValues.connectionString },
          });
        } else {
          await createSetting.mutateAsync({
            category: "azure",
            key: "connection_string",
            value: debouncedValues.connectionString,
            isEncrypted: true,
          });
        }

        setAutoSaveStatus("saved");
        toast.success("Azure Storage settings auto-saved successfully");

        // Clear saved status after a short delay
        setTimeout(() => {
          setAutoSaveStatus("idle");
        }, 2000);
      } catch (error) {
        setAutoSaveStatus("error");
        console.error("Auto-save failed:", error);
        toast.error(`Auto-save failed: ${(error as Error).message}`);

        // Clear error status after a delay
        setTimeout(() => {
          setAutoSaveStatus("idle");
        }, 3000);
      }
    }, 1000); // 1 second delay for auto-save

    return () => clearTimeout(autoSaveTimer);
  }, [
    debouncedValues.connectionString,
    form.formState.isValid,
    settings.connection_string,
    updateSetting,
    createSetting,
  ]);

  // Advanced validation with real-time connectivity testing
  const validation = useAdvancedSettingsValidation(
    "azure",
    form.formState.isValid ? debouncedValues : undefined,
    {
      enabled: form.formState.isValid,
      debounceDelay: 500,
      onValidationSuccess: () => {
        toast.success("Azure Storage connection validated successfully");
      },
      onValidationError: (_, error) => {
        toast.error(`Azure Storage validation failed: ${error.message}`);
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
      if (settingsMap.connection_string?.value) {
        form.setValue("connectionString", settingsMap.connection_string.value);
      }
    }
  }, [settingsData, form]);

  const handleSave = async (data: AzureSettingsFormData) => {
    try {
      // Save or update connection string setting (encrypted)
      if (settings.connection_string) {
        await updateSetting.mutateAsync({
          id: settings.connection_string.id,
          setting: { value: data.connectionString },
        });
      } else {
        await createSetting.mutateAsync({
          category: "azure",
          key: "connection_string",
          value: data.connectionString,
          isEncrypted: true,
        });
      }

      toast.success("Azure Storage settings saved successfully");
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

  // Parse metadata to show storage account details
  const metadata = latestConnectivity?.metadata
    ? JSON.parse(latestConnectivity.metadata)
    : null;

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
          <h1 className="text-3xl font-bold mb-2">
            Azure Storage Configuration
          </h1>
          <p className="text-muted-foreground">
            Configure Azure Storage for backup operations
          </p>
        </div>
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load Azure Storage settings: {settingsError.message}
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
            <Database className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Azure Storage Configuration</h1>
            <p className="text-muted-foreground">
              Configure Azure Storage connection for backup operations and data
              storage
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
                <CardTitle>Storage Account Configuration</CardTitle>
                <CardDescription>
                  Configure your Azure Storage Account connection string to
                  enable backup operations. Connection strings are stored
                  securely with encryption.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {settingsLoading ? (
                  <div className="space-y-4">
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
                        name="connectionString"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              <Shield className="inline mr-2 h-4 w-4" />
                              Connection String
                            </FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  type={
                                    showConnectionString ? "text" : "password"
                                  }
                                  placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
                                  {...field}
                                  className="pr-10"
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                  onClick={() =>
                                    setShowConnectionString(
                                      !showConnectionString,
                                    )
                                  }
                                >
                                  {showConnectionString ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </FormControl>
                            <FormDescription>
                              Your Azure Storage Account connection string. Find
                              this in the Azure portal under Storage Account →
                              Access Keys. It should include
                              DefaultEndpointsProtocol, AccountName, and
                              AccountKey.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="flex gap-3 items-center">
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

                        {/* Auto-save status indicator */}
                        {autoSaveStatus !== "idle" && (
                          <div className="flex items-center gap-2 text-sm">
                            {autoSaveStatus === "saving" && (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                                <span className="text-blue-600">
                                  Auto-saving...
                                </span>
                              </>
                            )}
                            {autoSaveStatus === "saved" && (
                              <>
                                <CheckCircle className="h-4 w-4 text-green-600" />
                                <span className="text-green-600">
                                  Auto-saved
                                </span>
                              </>
                            )}
                            {autoSaveStatus === "error" && (
                              <>
                                <XCircle className="h-4 w-4 text-red-600" />
                                <span className="text-red-600">
                                  Auto-save failed
                                </span>
                              </>
                            )}
                          </div>
                        )}
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

            {/* Storage Account Info */}
            {metadata && latestConnectivity?.status === "connected" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium">
                    <Server className="inline mr-2 h-4 w-4" />
                    Storage Account Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2">
                  <div>
                    <strong>Account Name:</strong> {metadata.accountName}
                  </div>
                  {metadata.accountKind && (
                    <div>
                      <strong>Account Kind:</strong> {metadata.accountKind}
                    </div>
                  )}
                  {metadata.skuName && (
                    <div>
                      <strong>SKU:</strong> {metadata.skuName}
                    </div>
                  )}
                  <div>
                    <strong>Containers:</strong> {metadata.containerCount || 0}
                  </div>
                  {metadata.containers && metadata.containers.length > 0 && (
                    <div>
                      <strong>Sample Containers:</strong>
                      <ul className="mt-1 text-xs text-muted-foreground">
                        {metadata.containers.map(
                          (container: string, index: number) => (
                            <li key={index}>• {container}</li>
                          ),
                        )}
                        {metadata.containerCount >
                          metadata.containers.length && (
                          <li>
                            • ... and{" "}
                            {metadata.containerCount -
                              metadata.containers.length}{" "}
                            more
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

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
                  <strong>Connection String:</strong> Found in Azure Portal
                  under your Storage Account → Access Keys
                </div>
                <div>
                  <strong>Security:</strong> Connection strings are encrypted
                  and stored securely in the database
                </div>
                <div>
                  <strong>Containers:</strong> Once validated, container
                  information will be available for backup operations
                </div>
                <div>
                  <strong>Permissions:</strong> Ensure your storage account
                  allows blob operations for backups to work
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Azure Connectivity Status Display */}
        <div className="mt-8">
          <AzureConnectivityStatus
            refreshInterval={30000} // 30 seconds
            showResponseTimeChart={true}
            showHistoryTimeline={true}
          />
        </div>

        {/* Container List - Only show when Azure connection is established */}
        {latestConnectivity?.status === "connected" && (
          <div className="mt-8">
            <AzureContainerList />
          </div>
        )}
      </div>
    </div>
  );
}
