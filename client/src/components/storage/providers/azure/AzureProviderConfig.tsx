import React, { useEffect, useState } from "react";
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
  IconCircleCheck,
  IconCircleX,
  IconEye,
  IconEyeOff,
  IconHelp,
  IconLoader2,
  IconShield,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useAzureProviderConfig,
  useStorageConnectivity,
  useUpdateAzureProviderConfig,
  useValidateAzureConnection,
} from "@/hooks/use-storage-settings";

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

export interface AzureProviderConfigProps {
  className?: string;
}

export const AzureProviderConfig = React.memo(function AzureProviderConfig({
  className,
}: AzureProviderConfigProps) {
  const queryClient = useQueryClient();
  const [showConnectionString, setShowConnectionString] = useState(false);
  const [validationState, setValidationState] = useState<{
    isValidating: boolean;
    isSuccess: boolean;
    error: string | null;
  }>({ isValidating: false, isSuccess: false, error: null });

  const { data: providerConfig, isLoading: configLoading } =
    useAzureProviderConfig();
  const { data: connectivity } = useStorageConnectivity();
  const updateConfig = useUpdateAzureProviderConfig();
  const validateConnection = useValidateAzureConnection();

  const isConnected = connectivity?.status === "connected";

  const form = useForm<AzureSettingsFormData>({
    resolver: zodResolver(azureSettingsSchema),
    defaultValues: { connectionString: "" },
    mode: "onChange",
  });

  // Note: we never receive the existing connection string back from the
  // server (it's encrypted at rest). Show a placeholder when one is
  // configured and force the operator to retype to update.
  useEffect(() => {
    // Reset the validation state visual when settings load.
    if (providerConfig?.connectionConfigured && !form.formState.isDirty) {
      setValidationState({
        isValidating: false,
        isSuccess: providerConfig.validationStatus === "connected",
        error:
          providerConfig.validationStatus &&
          providerConfig.validationStatus !== "connected"
            ? providerConfig.validationMessage ?? null
            : null,
      });
    }
  }, [providerConfig, form.formState.isDirty]);

  const handleValidateAndSave = async (data: AzureSettingsFormData) => {
    setValidationState({ isValidating: true, isSuccess: false, error: null });
    try {
      const validationResult = await validateConnection.mutateAsync({
        connectionString: data.connectionString,
      });
      if (!validationResult.isValid) {
        throw new Error(
          validationResult.message || "Connection validation failed",
        );
      }

      await updateConfig.mutateAsync({
        connectionString: data.connectionString,
      });

      await queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
      await queryClient.invalidateQueries({ queryKey: ["storage"] });
      setValidationState({
        isValidating: false,
        isSuccess: true,
        error: null,
      });
      toast.success(
        "Azure Storage connection validated and saved successfully",
      );
    } catch (error) {
      const errorMessage = (error as Error).message;
      setValidationState({
        isValidating: false,
        isSuccess: false,
        error: errorMessage,
      });
      toast.error(`Failed to validate and save: ${errorMessage}`);
    }
  };

  const isSaving =
    updateConfig.isPending ||
    validateConnection.isPending ||
    validationState.isValidating;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Azure Storage Account</CardTitle>
        <CardDescription>
          Configure your Azure Storage Account connection string. Connection
          strings are stored encrypted at rest.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {configLoading ? (
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
                  <FormItem data-tour="storage-azure-connection-string-input">
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
                                <strong>Security:</strong> Connection strings
                                are encrypted and stored securely in the
                                database
                              </div>
                              <div>
                                <strong>Locations:</strong> Once validated,
                                available containers will be listed below for
                                selection
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
                          placeholder={
                            providerConfig?.connectionConfigured
                              ? "•••••••••••••••• (leave blank to keep existing)"
                              : "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
                          }
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
                      Your Azure Storage Account connection string. Find this
                      in the Azure portal under Storage Account → Access Keys.
                      It should include DefaultEndpointsProtocol, AccountName,
                      and AccountKey.
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
                  data-tour="storage-validate-button"
                >
                  {isSaving ? (
                    <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <IconCircleCheck className="mr-2 h-4 w-4" />
                  )}
                  Validate & Save
                </Button>
                {providerConfig?.accountName && (
                  <span className="text-sm text-muted-foreground">
                    Account: <strong>{providerConfig.accountName}</strong>
                  </span>
                )}
              </div>
            </form>
          </Form>
        )}

        {isConnected && (
          <Alert className="bg-green-50 border-green-200 mt-6 dark:bg-green-950 dark:border-green-800">
            <IconCircleCheck className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700 dark:text-green-300">
              Storage connection is active and healthy. The system can perform
              backup operations against this account.
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
      </CardContent>
    </Card>
  );
});
