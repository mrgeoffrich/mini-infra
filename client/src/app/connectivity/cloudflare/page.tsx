import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "react-router-dom";
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
  useSystemSettings,
  useCreateSystemSetting,
  useUpdateSystemSetting,
} from "@/hooks/use-settings";
import { useValidateService } from "@/hooks/use-settings-validation";
import {
  IconCloud,
  IconCircleCheck,
  IconCircleX,
  IconAlertCircle,
  IconArrowLeft,
  IconLoader2,
  IconEye,
  IconEyeOff,
  IconShield,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { SystemSettingsInfo } from "@mini-infra/types";

// Cloudflare settings schema
const cloudflareSettingsSchema = z.object({
  apiToken: z
    .string()
    .min(1, "Cloudflare API token is required")
    .min(40, "API token must be at least 40 characters")
    .regex(/^[A-Za-z0-9_-]+$/, "API token contains invalid characters"),
  accountId: z
    .string()
    .min(1, "Account ID is required")
    .regex(
      /^[a-f0-9]{32}$/,
      "Account ID must be a valid 32-character hex string"
    ),
});

type CloudflareSettingsFormData = z.infer<typeof cloudflareSettingsSchema>;


export default function CloudflareSettingsPage() {
  const queryClient = useQueryClient();
  const [showApiToken, setShowApiToken] = useState(false);
  const [validationState, setValidationState] = useState<{
    isValidating: boolean;
    isSuccess: boolean;
    error: string | null;
  }>({ isValidating: false, isSuccess: false, error: null });
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {}
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

  // Validation service
  const validateService = useValidateService();

  // Update form when settings are loaded
  useEffect(() => {
    if (settingsData?.data) {
      const settingsMap = settingsData.data.reduce(
        (acc, setting) => {
          acc[setting.key] = setting;
          return acc;
        },
        {} as Record<string, SystemSettingsInfo>
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

  const handleValidateAndSave = async (data: CloudflareSettingsFormData) => {
    setValidationState({ isValidating: true, isSuccess: false, error: null });

    try {
      // Step 1: Validate the connection settings
      const validationResult = await validateService.mutateAsync({
        service: "cloudflare",
        settings: { apiToken: data.apiToken, accountId: data.accountId },
      });

      if (!validationResult.data.isValid) {
        throw new Error(validationResult.message || "Connection validation failed");
      }

      // Step 2: Save settings if validation passed
      const promises: Promise<unknown>[] = [];

      // Save or update API token setting (encrypted)
      if (settings.api_token) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.api_token.id,
            setting: { value: data.apiToken },
          })
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "cloudflare",
            key: "api_token",
            value: data.apiToken,
            isEncrypted: true,
          })
        );
      }

      // Save or update account ID setting if provided
      if (data.accountId) {
        if (settings.account_id) {
          promises.push(
            updateSetting.mutateAsync({
              id: settings.account_id.id,
              setting: { value: data.accountId },
            })
          );
        } else {
          promises.push(
            createSetting.mutateAsync({
              category: "cloudflare",
              key: "account_id",
              value: data.accountId,
              isEncrypted: false,
            })
          );
        }
      }

      await Promise.all(promises);

      // Step 3: Force refresh connectivity status and show success feedback
      await queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
      setValidationState({ isValidating: false, isSuccess: true, error: null });
      toast.success("Cloudflare connection validated and saved successfully");

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

  if (settingsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/connectivity/overview">
                <IconArrowLeft className="h-4 w-4" />
                Back to Connectivity
              </Link>
            </Button>
          </div>
        </div>

        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
              <IconCloud className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Cloudflare Configuration</h1>
              <p className="text-muted-foreground">
                Configure Cloudflare API access and tunnel settings
              </p>
            </div>
          </div>

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
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
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/connectivity/overview">
              <IconArrowLeft className="h-4 w-4" />
              Back to Connectivity
            </Link>
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
            <IconCloud className="h-6 w-6" />
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
        {/* Configuration Form */}
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
                      onSubmit={form.handleSubmit(handleValidateAndSave)}
                      className="space-y-6"
                    >
                      <FormField
                        control={form.control}
                        name="apiToken"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              <IconShield className="inline mr-2 h-4 w-4" />
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
                                    <IconEyeOff className="h-4 w-4" />
                                  ) : (
                                    <IconEye className="h-4 w-4" />
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
                            <FormLabel>Account ID</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="32-character account identifier"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              Your Cloudflare Account ID is required. You can
                              find your Account ID in the URL when you browse to
                              the dashboard - for example
                              https://dash.cloudflare.com/xxxxxxxxxxxxxx/home
                              where xxxxxxxxxxxxxx is your Account ID.
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
              Cloudflare connection has been validated and configured successfully.
              The system can now monitor your tunnels and manage Cloudflare resources.
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

        {/* Tunnel Management Link */}
        <div className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Tunnel Management</CardTitle>
              <CardDescription>
                View and monitor your Cloudflare tunnel connections,
                configurations, and routing rules
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link to="/tunnels" className="flex items-center gap-2">
                  <IconCloud className="h-4 w-4" />
                  View Tunnels
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
