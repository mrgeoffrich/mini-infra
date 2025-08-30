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
  Cloud,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  ArrowLeft,
  Save,
  TestTube,
  Loader2,
  Eye,
  EyeOff,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { SystemSettingsInfo } from "@mini-infra/types";
import { TunnelStatus } from "@/components/cloudflare/tunnel-status";

// Cloudflare settings schema
const cloudflareSettingsSchema = z.object({
  apiToken: z
    .string()
    .min(1, "Cloudflare API token is required")
    .min(40, "API token must be at least 40 characters")
    .regex(/^[A-Za-z0-9_-]+$/, "API token contains invalid characters"),
  accountId: z
    .string()
    .optional()
    .refine(
      (val) => !val || /^[a-f0-9]{32}$/.test(val),
      "Account ID must be a valid 32-character hex string",
    ),
});

type CloudflareSettingsFormData = z.infer<typeof cloudflareSettingsSchema>;

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

export default function CloudflareSettingsPage() {
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [showApiToken, setShowApiToken] = useState(false);
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );

  // Fetch existing Cloudflare settings
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
  } = useSystemSettings({
    filters: { category: "cloudflare", isActive: true },
    limit: 50,
  });

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<CloudflareSettingsFormData>({
    resolver: zodResolver(cloudflareSettingsSchema),
    defaultValues: {
      apiToken: "",
      accountId: "",
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
    "cloudflare",
    form.formState.isValid ? debouncedValues : undefined,
    {
      enabled: form.formState.isValid,
      debounceDelay: 500,
      onValidationSuccess: () => {
        toast.success("Cloudflare connection validated successfully");
      },
      onValidationError: (_, error) => {
        toast.error(`Cloudflare validation failed: ${error.message}`);
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

      // Update form with current values (backend uses snake_case keys)
      if (settingsMap.api_token?.value) {
        form.setValue("apiToken", settingsMap.api_token.value);
      }
      if (settingsMap.account_id?.value) {
        form.setValue("accountId", settingsMap.account_id.value);
      }
    }
  }, [settingsData, form]);

  const handleSave = async (data: CloudflareSettingsFormData) => {
    try {
      const promises: Promise<unknown>[] = [];

      // Save or update API token setting (encrypted)
      if (settings.api_token) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.api_token.id,
            setting: { value: data.apiToken },
          }),
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "cloudflare",
            key: "api_token",
            value: data.apiToken,
            isEncrypted: true,
          }),
        );
      }

      // Save or update account ID setting if provided
      if (data.accountId) {
        if (settings.account_id) {
          promises.push(
            updateSetting.mutateAsync({
              id: settings.account_id.id,
              setting: { value: data.accountId },
            }),
          );
        } else {
          promises.push(
            createSetting.mutateAsync({
              category: "cloudflare",
              key: "account_id",
              value: data.accountId,
              isEncrypted: false,
            }),
          );
        }
      }

      await Promise.all(promises);
      toast.success("Cloudflare settings saved successfully");
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
          <h1 className="text-3xl font-bold mb-2">Cloudflare Configuration</h1>
          <p className="text-muted-foreground">
            Configure Cloudflare API access and tunnel settings
          </p>
        </div>
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load Cloudflare settings: {settingsError.message}
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
          <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
            <Cloud className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Cloudflare Configuration</h1>
            <p className="text-muted-foreground">
              Configure Cloudflare API access for tunnel management and
              monitoring
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
                <CardTitle>API Configuration</CardTitle>
                <CardDescription>
                  Configure your Cloudflare API token to enable tunnel
                  monitoring and management features. API tokens are stored
                  securely with encryption.
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
                        name="apiToken"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              <Shield className="inline mr-2 h-4 w-4" />
                              API Token
                            </FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  type={showApiToken ? "text" : "password"}
                                  placeholder="Enter your Cloudflare API token"
                                  {...field}
                                  className="pr-10"
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                  onClick={() => setShowApiToken(!showApiToken)}
                                >
                                  {showApiToken ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </FormControl>
                            <FormDescription>
                              Your Cloudflare API token with Zone:Read and
                              Tunnel:Read permissions. Create one at{" "}
                              <a
                                href="https://dash.cloudflare.com/profile/api-tokens"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                dash.cloudflare.com
                              </a>
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="accountId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Account ID (Optional)</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="32-character account identifier"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              Your Cloudflare Account ID for enhanced tunnel
                              management. Found in your Cloudflare dashboard
                              sidebar.
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

          </div>
        </div>

        {/* Tunnel Status Display */}
        <div className="mt-6">
          <TunnelStatus />
        </div>
      </div>
    </div>
  );
}
