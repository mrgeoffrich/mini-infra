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
  Container,
  CheckCircle,
  XCircle,
  AlertCircle,
  ArrowLeft,
  Loader2,
  Zap,
  HelpCircle,
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

  // Mutations for saving settings
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  // Form setup
  const form = useForm<DockerSettingsFormData>({
    resolver: zodResolver(dockerSettingsSchema),
    defaultValues: {
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
      version: "1.51",
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
        {} as Record<string, SystemSettingsInfo>,
      );
      setSettings(settingsMap);

      // Update form with current values
      if (settingsMap.host?.value) {
        form.setValue("host", settingsMap.host.value);
      }
      if (settingsMap.apiVersion?.value) {
        form.setValue("version", settingsMap.apiVersion.value);
      }
    }
  }, [settingsData, form]);

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

  if (settingsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/connectivity/overview">
                <ArrowLeft className="h-4 w-4" />
                Back to Connectivity
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
            <Link to="/connectivity/overview">
              <ArrowLeft className="h-4 w-4" />
              Back to Connectivity
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
                                    <HelpCircle className="h-4 w-4" />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-80">
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <Zap className="h-4 w-4" />
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
                                    <HelpCircle className="h-4 w-4" />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-80">
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <Zap className="h-4 w-4" />
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
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle className="mr-2 h-4 w-4" />
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
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700">
              Docker connection has been validated and configured successfully.
              The system can now manage Docker containers and perform operations.
            </AlertDescription>
          </Alert>
        )}

        {validationState.error && (
          <Alert variant="destructive" className="mt-6">
            <XCircle className="h-4 w-4" />
            <AlertDescription>
              Validation failed: {validationState.error}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
