import { useState } from "react";
import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useCreatePostgresBackupConfig,
  useUpdatePostgresBackupConfig,
  useDeletePostgresBackupConfig,
} from "@/hooks/use-postgres-backup-configs";
import { useCreateManualBackup } from "@/hooks/use-postgres-backup-operations";
import { useAzureContainers } from "@/hooks/use-azure-settings";
import { useUserPreferences, useTimezones } from "@/hooks/use-user-preferences";
import {
  AlertCircle,
  Loader2,
  Calendar,
  Clock,
  Play,
  Save,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import { toast } from "sonner";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { cn } from "@/lib/utils";
import { backupConfigSchema, type BackupConfigFormData } from "./schemas";
import type {
  PostgresDatabaseInfo,
  BackupConfigurationInfo,
  CreateBackupConfigurationRequest,
  UpdateBackupConfigurationRequest,
} from "@mini-infra/types";

interface BackupConfigurationModalProps {
  database: PostgresDatabaseInfo;
  backupConfig?: BackupConfigurationInfo | null;
  isOpen: boolean;
  onClose: () => void;
}

export function BackupConfigurationModal({
  database,
  backupConfig,
  isOpen,
  onClose,
}: BackupConfigurationModalProps) {
  const { formatDateTime } = useFormattedDate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);
  const isEditing = !!backupConfig;

  const createMutation = useCreatePostgresBackupConfig();
  const updateMutation = useUpdatePostgresBackupConfig();
  const deleteMutation = useDeletePostgresBackupConfig();
  const manualBackupMutation = useCreateManualBackup();

  // Fetch Azure containers for dropdown
  const { data: azureContainersResponse, isLoading: containersLoading } =
    useAzureContainers({
      enabled: isOpen, // Only fetch when modal is open
    });

  // Fetch user preferences and timezones
  const { data: userPreferences } = useUserPreferences();
  const { data: timezones } = useTimezones();

  const form = useForm<BackupConfigFormData>({
    resolver: zodResolver(backupConfigSchema),
    defaultValues: {
      schedule: backupConfig?.schedule || "0 2 * * *", // Daily at 2 AM
      timezone: backupConfig?.timezone || userPreferences?.timezone || "UTC",
      azureContainerName:
        backupConfig?.azureContainerName || "postgres-backups",
      azurePathPrefix: backupConfig?.azurePathPrefix || database.name,
      retentionDays: backupConfig?.retentionDays || 30,
      backupFormat: backupConfig?.backupFormat || "custom",
      compressionLevel: backupConfig?.compressionLevel || 6,
      isEnabled: backupConfig?.isEnabled ?? true,
    },
    mode: "onChange",
  });

  const onSubmit = async (data: BackupConfigFormData) => {
    setSubmitError(null);
    try {
      if (isEditing && backupConfig) {
        const updateData: UpdateBackupConfigurationRequest = data;
        await updateMutation.mutateAsync({
          id: backupConfig.id,
          request: updateData,
        });
        toast.success("Backup configuration updated successfully");
      } else {
        const createData: CreateBackupConfigurationRequest = {
          databaseId: database.id,
          ...data,
        };
        await createMutation.mutateAsync(createData);
        toast.success("Backup configuration created successfully");
      }
      onClose();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      setSubmitError(errorMessage);
    }
  };

  const handleDelete = async () => {
    if (!backupConfig) return;

    try {
      await deleteMutation.mutateAsync({
        id: backupConfig.id,
        databaseId: database.id,
      });
      toast.success("Backup configuration deleted successfully");
      onClose();
    } catch (error) {
      toast.error(
        `Failed to delete backup configuration: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  };

  const triggerManualBackup = async () => {
    try {
      await manualBackupMutation.mutateAsync(database.id);
      toast.success("Manual backup triggered successfully");
    } catch (error) {
      toast.error(
        `Failed to trigger manual backup: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  };

  // Clear error when modal opens/closes
  React.useEffect(() => {
    if (isOpen) {
      setSubmitError(null);
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Backup Configuration" : "Configure Backup"}
          </DialogTitle>
          <DialogDescription>
            Configure automated backups for {database.name}
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {submitError.includes("container") ||
              submitError.includes("Azure")
                ? `Azure Storage Error: ${submitError}. Please ensure the Azure Storage account is configured and the container exists.`
                : submitError}
            </AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Enable/Disable Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center space-x-3">
                <Calendar className="w-5 h-5 text-blue-500" />
                <div>
                  <h3 className="font-medium">Backup Schedule</h3>
                  <p className="text-sm text-muted-foreground">
                    Enable automated backups for this database
                  </p>
                </div>
              </div>
              <FormField
                control={form.control}
                name="isEnabled"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <div className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={field.onChange}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">
                          {field.value ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            {/* Schedule Configuration */}
            <FormField
              control={form.control}
              name="schedule"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cron Schedule</FormLabel>
                  <FormControl>
                    <Input placeholder="0 2 * * * (Daily at 2 AM)" {...field} />
                  </FormControl>
                  <FormDescription>
                    Cron expression for backup schedule. Examples: "0 2 * * *"
                    (daily at 2 AM), "0 2 * * 0" (weekly on Sunday)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Timezone Configuration */}
            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Timezone</FormLabel>
                  <Popover open={timezonePopoverOpen} onOpenChange={setTimezonePopoverOpen}>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant="outline"
                          role="combobox"
                          className={cn(
                            "w-full justify-between",
                            !field.value && "text-muted-foreground"
                          )}
                        >
                          {field.value
                            ? timezones?.find((timezone) => timezone.value === field.value)?.label
                            : "Select a timezone"}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] max-w-[400px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search timezones..." />
                        <CommandList>
                          <CommandEmpty>No timezone found.</CommandEmpty>
                          <CommandGroup>
                            {(timezones || []).map((timezone) => (
                              <CommandItem
                                value={timezone.label}
                                key={timezone.value}
                                onSelect={() => {
                                  field.onChange(timezone.value);
                                  setTimezonePopoverOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    timezone.value === field.value
                                      ? "opacity-100"
                                      : "opacity-0"
                                  )}
                                />
                                {timezone.label}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <FormDescription>
                    Timezone for the backup schedule. Current time: {" "}
                    {form.watch("timezone") && new Date().toLocaleString("en-US", { 
                      timeZone: form.watch("timezone") || "UTC",
                      dateStyle: "short",
                      timeStyle: "medium"
                    })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Next Scheduled Time */}
            {backupConfig?.nextScheduledAt && form.watch("isEnabled") && (
              <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                <Clock className="w-4 h-4" />
                <span>
                  Next backup scheduled for:{" "}
                  {new Date(backupConfig.nextScheduledAt).toLocaleString("en-US", {
                    timeZone: form.watch("timezone") || backupConfig.timezone || "UTC",
                    dateStyle: "medium",
                    timeStyle: "short"
                  })} ({form.watch("timezone") || backupConfig.timezone || "UTC"})
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              {/* Azure Container */}
              <FormField
                control={form.control}
                name="azureContainerName"
                render={({ field }) => {
                  const containers =
                    azureContainersResponse?.data?.containers || [];

                  return (
                    <FormItem>
                      <FormLabel>Container</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={containersLoading}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue
                              placeholder={
                                containersLoading
                                  ? "Loading containers..."
                                  : containers.length === 0
                                    ? "No containers available"
                                    : "Select container"
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {containers.map((container) => (
                            <SelectItem
                              key={container.name}
                              value={container.name}
                            >
                              {container.name}
                            </SelectItem>
                          ))}
                          {containers.length === 0 && !containersLoading && (
                            <SelectItem value="" disabled>
                              No containers found
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Azure Storage container for backups
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />

              {/* Path Prefix */}
              <FormField
                control={form.control}
                name="azurePathPrefix"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Path Prefix</FormLabel>
                    <FormControl>
                      <Input placeholder={database.name} {...field} />
                    </FormControl>
                    <FormDescription>
                      Folder path within the container
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Retention Policy */}
              <FormField
                control={form.control}
                name="retentionDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Retention (Days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="30"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>Days to keep backups</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Backup Format */}
              <FormField
                control={form.control}
                name="backupFormat"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Format</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select format" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="custom">Custom</SelectItem>
                        <SelectItem value="plain">Plain</SelectItem>
                        <SelectItem value="tar">TAR</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>pg_dump format</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Compression Level */}
              <FormField
                control={form.control}
                name="compressionLevel"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Compression</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="6"
                        min="0"
                        max="9"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>0-9 (0=none, 9=max)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Last Backup Info */}
            {backupConfig?.lastBackupAt && (
              <div className="p-3 bg-muted rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="text-sm">
                    <span className="font-medium">Last backup:</span>{" "}
                    {formatDateTime(backupConfig.lastBackupAt)}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={triggerManualBackup}
                    disabled={manualBackupMutation.isPending}
                  >
                    {manualBackupMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="w-4 h-4 mr-2" />
                    )}
                    Run Manual Backup
                  </Button>
                </div>
              </div>
            )}

            <DialogFooter>
              <div className="flex items-center justify-between w-full">
                <div>
                  {isEditing && (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending && (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      )}
                      Delete Configuration
                    </Button>
                  )}
                </div>
                <div className="flex space-x-2">
                  <Button type="button" variant="outline" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      createMutation.isPending ||
                      updateMutation.isPending ||
                      deleteMutation.isPending
                    }
                  >
                    {(createMutation.isPending || updateMutation.isPending) && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    <Save className="w-4 h-4 mr-2" />
                    {isEditing ? "Update" : "Create"}
                  </Button>
                </div>
              </div>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}