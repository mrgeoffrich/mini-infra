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
  useConnectivityStatus,
} from "@/hooks/use-settings";
import { useValidateService } from "@/hooks/use-settings-validation";
import {
  IconDatabase,
  IconCircleCheck,
  IconCircleX,
  IconAlertCircle,
  IconLoader2,
  IconEye,
  IconEyeOff,
  IconShield,
  IconHelp,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { SystemSettingsInfo, SettingsCategory } from "@mini-infra/types";
import { AzureContainerList } from "@/components/azure";
import { AzureContainerSelector } from "@/components/AzureContainerSelector";

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


export default function AzureSettingsPage() {
  const queryClient = useQueryClient();
  const [showConnectionString, setShowConnectionString] = useState(false);
  const [validationState, setValidationState] = useState<{
    isValidating: boolean;
    isSuccess: boolean;
    error: string | null;
  }>({ isValidating: false, isSuccess: false, error: null });
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );
  const [defaultContainer, setDefaultContainer] = useState<string>("");
  const [selfBackupContainer, setSelfBackupContainer] = useState<string>("");
  const [tlsCertContainer, setTlsCertContainer] = useState<string>("");
  const [isSavingContainer, setIsSavingContainer] = useState(false);

  // Fetch existing Azure settings
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
  } = useSystemSettings({
    filters: { category: "azure", isActive: true },
    limit: 50,
  });

  // Fetch default backup container setting (from system category)
  const {
    data: systemSettingsData,
    isLoading: systemSettingsLoading,
  } = useSystemSettings({
    filters: {
      category: "system",
      key: "default_postgres_backup_container",
      isActive: true,
    },
    limit: 1,
  });

  // Fetch self-backup container setting
  const {
    data: selfBackupSettingsData,
  } = useSystemSettings({
    filters: {
      category: "self-backup",
      key: "azure_container_name",
      isActive: true,
    },
    limit: 1,
  });

  // Fetch TLS certificate container setting
  const {
    data: tlsSettingsData,
  } = useSystemSettings({
    filters: {
      category: "tls",
      key: "certificate_blob_container",
      isActive: true,
    },
    limit: 1,
  });

  // Fetch connectivity status
  const {
    data: connectivityData,
  } = useConnectivityStatus({
    filters: { service: "azure" },
    limit: 10,
    refetchInterval: 30000, // Poll every 30 seconds
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

  // Validation service
  const validateService = useValidateService();

  // Get latest Azure connectivity status
  const azureConnectivity = connectivityData?.data?.[0]; // Most recent status
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
      if (settingsMap.connection_string?.value) {
        form.setValue("connectionString", settingsMap.connection_string.value);
      }
    }
  }, [settingsData, form]);

  // Update container values when settings are loaded
  useEffect(() => {
    if (systemSettingsData?.data?.[0]?.value) {
      setDefaultContainer(systemSettingsData.data[0].value);
    }
  }, [systemSettingsData]);

  useEffect(() => {
    if (selfBackupSettingsData?.data?.[0]?.value) {
      setSelfBackupContainer(selfBackupSettingsData.data[0].value);
    }
  }, [selfBackupSettingsData]);

  useEffect(() => {
    if (tlsSettingsData?.data?.[0]?.value) {
      setTlsCertContainer(tlsSettingsData.data[0].value);
    }
  }, [tlsSettingsData]);

  const handleValidateAndSave = async (data: AzureSettingsFormData) => {
    setValidationState({ isValidating: true, isSuccess: false, error: null });

    try {
      // Step 1: Validate the connection settings
      const validationResult = await validateService.mutateAsync({
        service: "azure",
        settings: { connectionString: data.connectionString },
      });

      if (!validationResult.data.isValid) {
        throw new Error(validationResult.message || "Connection validation failed");
      }

      // Step 2: Save settings if validation passed
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

      // Step 3: Force refresh connectivity status and show success feedback
      await queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
      setValidationState({ isValidating: false, isSuccess: true, error: null });
      toast.success("Azure Storage connection validated and saved successfully");

    } catch (error) {
      const errorMessage = (error as Error).message;
      setValidationState({ isValidating: false, isSuccess: false, error: errorMessage });
      toast.error(`Failed to validate and save: ${errorMessage}`);
    }
  };

  const handleContainerChange = async (
    containerName: string,
    category: SettingsCategory,
    key: string,
    existingSetting: SystemSettingsInfo | undefined,
    setter: (val: string) => void,
    label: string,
  ) => {
    setter(containerName);
    setIsSavingContainer(true);

    try {
      if (existingSetting) {
        await updateSetting.mutateAsync({
          id: existingSetting.id,
          setting: { value: containerName },
        });
      } else {
        await createSetting.mutateAsync({
          category,
          key,
          value: containerName,
          isEncrypted: false,
        });
      }

      toast.success(`${label} updated successfully`);
    } catch (error) {
      const errorMessage = (error as Error).message;
      toast.error(`Failed to save ${label.toLowerCase()}: ${errorMessage}`);
    } finally {
      setIsSavingContainer(false);
    }
  };

  const isSaving = createSetting.isPending || updateSetting.isPending || validationState.isValidating;

  if (settingsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconDatabase className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">
                Azure Storage Configuration
              </h1>
              <p className="text-muted-foreground">
                Configure Azure Storage for backup operations
              </p>
            </div>
          </div>

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
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
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconDatabase className="h-6 w-6" />
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
        {/* Configuration Form */}
        <Card>
          <CardHeader>
            <CardTitle>Storage Account Configuration</CardTitle>
            <CardDescription>
              Configure your Azure Storage Account connection string to enable
              backup operations. Connection strings are stored securely with
              encryption.
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
                  onSubmit={form.handleSubmit(handleValidateAndSave)}
                  className="space-y-6"
                >
                  <FormField
                    control={form.control}
                    name="connectionString"
                    render={({ field }) => (
                      <FormItem data-tour="azure-connection-string-input">
                        <FormLabel className="flex items-center gap-2">
                          <IconShield className="h-4 w-4" />
                          Connection String
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-auto p-0 text-muted-foreground hover:text-foreground"
                              >
                                <IconHelp className="h-4 w-4" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80">
                              <div className="space-y-3">
                                <h4 className="font-medium leading-none">
                                  Quick Tips
                                </h4>
                                <div className="text-sm space-y-2">
                                  <div>
                                    <strong>Connection String:</strong> Found in
                                    Azure Portal under your Storage Account →
                                    Access Keys
                                  </div>
                                  <div>
                                    <strong>Security:</strong> Connection
                                    strings are encrypted and stored securely in
                                    the database
                                  </div>
                                  <div>
                                    <strong>Containers:</strong> Once validated,
                                    container information will be available for
                                    backup operations
                                  </div>
                                  <div>
                                    <strong>Permissions:</strong> Ensure your
                                    storage account allows blob operations for
                                    backups to work
                                  </div>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type={showConnectionString ? "text" : "password"}
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
                                setShowConnectionString(!showConnectionString)
                              }
                            >
                              {showConnectionString ? (
                                <IconEyeOff className="h-4 w-4" />
                              ) : (
                                <IconEye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </FormControl>
                        <FormDescription>
                          Your Azure Storage Account connection string. Find
                          this in the Azure portal under Storage Account →
                          Access Keys. It should include
                          DefaultEndpointsProtocol, AccountName, and AccountKey.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex gap-3 items-center">
                    <Button
                      type="submit"
                      disabled={!form.formState.isValid || isSaving}
                      className="bg-green-600 hover:bg-green-700"
                      data-tour="azure-validate-button"
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
        {isAzureConnected && (
          <Alert className="bg-green-50 border-green-200 mt-6">
            <IconCircleCheck className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700">
              Azure Storage connection is active and healthy.
              The system can perform backup operations to your storage account.
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

        {/* Container List - Show when Azure is connected */}
        {isAzureConnected && (
          <div className="mt-8" data-tour="azure-container-list">
            <AzureContainerList />
          </div>
        )}

        {/* Storage Container Assignments */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Storage Container Assignments</CardTitle>
            <CardDescription>
              Assign Azure Storage containers for each system function. Containers must already exist in your storage account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Default Postgres Backup Container */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Default Postgres Backup Container</label>
              <p className="text-xs text-muted-foreground">
                Pre-selected when setting up new database backup configurations
              </p>
              {systemSettingsLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <div data-tour="azure-default-container-selector">
                  <AzureContainerSelector
                    value={defaultContainer}
                    onChange={(val) => handleContainerChange(val, "system", "default_postgres_backup_container", systemSettingsData?.data?.[0], setDefaultContainer, "Default backup container")}
                    disabled={!isAzureConnected || isSavingContainer}
                    placeholder="Select default backup container..."
                  />
                </div>
              )}
            </div>

            {/* Self-Backup Container */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Self-Backup Container</label>
              <p className="text-xs text-muted-foreground">
                Where Mini Infra stores its own database backups
              </p>
              <div data-tour="azure-self-backup-container-selector">
                <AzureContainerSelector
                  value={selfBackupContainer}
                  onChange={(val) => handleContainerChange(val, "self-backup", "azure_container_name", selfBackupSettingsData?.data?.[0], setSelfBackupContainer, "Self-backup container")}
                  disabled={!isAzureConnected || isSavingContainer}
                  placeholder="Select self-backup container..."
                />
              </div>
            </div>

            {/* TLS Certificate Container */}
            <div className="space-y-2">
              <label className="text-sm font-medium">TLS Certificate Container</label>
              <p className="text-xs text-muted-foreground">
                Where TLS certificates and private keys are stored
              </p>
              <div data-tour="azure-tls-container-selector">
                <AzureContainerSelector
                  value={tlsCertContainer}
                  onChange={(val) => handleContainerChange(val, "tls", "certificate_blob_container", tlsSettingsData?.data?.[0], setTlsCertContainer, "TLS certificate container")}
                  disabled={!isAzureConnected || isSavingContainer}
                  placeholder="Select TLS certificate container..."
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
