import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconDatabase,
  IconClock,
  IconDeviceFloppy,
  IconPlayerPlay,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconDownload,
  IconRefresh,
} from "@tabler/icons-react";
import { Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import {
  useSelfBackupConfig,
  useUpdateSelfBackupConfig,
  useEnableSelfBackup,
  useDisableSelfBackup,
  useTriggerManualBackup,
  useBackupHistory,
  type SelfBackupInfo,
} from "@/hooks/use-self-backup";
import { useAzureContainers } from "@/hooks/use-azure-settings";
import { useConnectivityStatus } from "@/hooks/use-settings";
import { useFormattedDateTime } from "@/hooks/use-formatted-date";
import { useUserPreferences, useTimezones } from "@/hooks/use-user-preferences";
import { formatBytes, formatDuration, cn } from "@/lib/utils";

// Configuration form schema
const configSchema = z.object({
  cronSchedule: z.string().min(1, "Cron schedule is required"),
  azureContainerName: z.string().min(1, "Azure container is required"),
  timezone: z.string().min(1, "Timezone is required"),
});

type ConfigFormData = z.infer<typeof configSchema>;

// Cron presets for quick selection
const cronPresets = [
  {
    label: "Hourly",
    value: "0 * * * *",
    description: "Every hour at :00",
  },
  {
    label: "Every 6 Hours",
    value: "0 */6 * * *",
    description: "At 12 AM, 6 AM, 12 PM, 6 PM",
  },
  {
    label: "Daily at Midnight",
    value: "0 0 * * *",
    description: "Every day at 12:00 AM",
  },
  {
    label: "Daily at 2 AM",
    value: "0 2 * * *",
    description: "Every day at 2:00 AM",
  },
];


// Error details dialog component
function ErrorDetailsDialog({
  backup,
  open,
  onOpenChange,
}: {
  backup: SelfBackupInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const formatDateTime = useFormattedDateTime(
    backup?.startedAt ? new Date(backup.startedAt) : null
  );

  if (!backup) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconAlertTriangle className="h-5 w-5 text-red-600" />
            Backup Error Details
          </DialogTitle>
          <DialogDescription>
            Error occurred during backup operation
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              Backup ID
            </div>
            <div className="text-sm font-mono">{backup.id}</div>
          </div>
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              Started At
            </div>
            <div className="text-sm">{formatDateTime || "N/A"}</div>
          </div>
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              Error Code
            </div>
            <div className="text-sm font-mono">
              {backup.errorCode || "UNKNOWN"}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              Error Message
            </div>
            <div className="text-sm bg-red-50 dark:bg-red-950 p-3 rounded border border-red-200 dark:border-red-800">
              {backup.errorMessage || "No error message available"}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SelfBackupSettingsPage() {
  const [selectedBackup, setSelectedBackup] = useState<SelfBackupInfo | null>(
    null
  );
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);

  // API hooks
  const { data: configData, isLoading: isLoadingConfig } =
    useSelfBackupConfig();
  const { data: azureData, isLoading: isLoadingContainers } =
    useAzureContainers();
  const { data: azureConnectivity } = useConnectivityStatus({
    filters: { service: "azure" },
    limit: 1,
  });
  const { data: userPreferences } = useUserPreferences();
  const { data: timezones } = useTimezones();
  const updateConfig = useUpdateSelfBackupConfig();
  const enableBackup = useEnableSelfBackup();
  const disableBackup = useDisableSelfBackup();
  const triggerBackup = useTriggerManualBackup();

  // Backup history
  const historyFilter =
    statusFilter === "all" ? undefined : (statusFilter as "completed" | "failed" | "in_progress");
  const {
    data: historyData,
    isLoading: isLoadingHistory,
    refetch: refetchHistory,
  } = useBackupHistory({
    status: historyFilter,
    page,
    limit: 10,
  });

  // Check if Azure is connected
  const isAzureConnected =
    azureConnectivity?.data?.[0]?.status === "connected";

  // Form setup
  const form = useForm<ConfigFormData>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      cronSchedule: configData?.config?.cronSchedule || "0 * * * *",
      azureContainerName: configData?.config?.azureContainerName || "",
      timezone: configData?.config?.timezone || userPreferences?.timezone || "UTC",
    },
  });

  // Update form when config loads
  useEffect(() => {
    if (configData?.config) {
      form.reset({
        cronSchedule: configData.config.cronSchedule,
        azureContainerName: configData.config.azureContainerName,
        timezone: configData.config.timezone || userPreferences?.timezone || "UTC",
      });
    }
  }, [configData, form, userPreferences]);

  // Handle configuration save
  const onSubmit = async (data: ConfigFormData) => {
    try {
      await updateConfig.mutateAsync(data);
      toast.success("Self-backup configuration updated successfully");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update configuration"
      );
    }
  };

  // Handle enable/disable
  const handleToggleEnabled = async (enabled: boolean) => {
    try {
      if (enabled) {
        await enableBackup.mutateAsync();
        toast.success("Self-backup schedule enabled");
      } else {
        await disableBackup.mutateAsync();
        toast.success("Self-backup schedule disabled");
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to ${enabled ? "enable" : "disable"} self-backup`
      );
    }
  };

  // Handle manual trigger
  const handleTriggerBackup = async () => {
    try {
      await triggerBackup.mutateAsync();
      toast.success("Backup triggered successfully");
      refetchHistory();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to trigger backup"
      );
    }
  };

  // Handle error dialog
  const handleViewError = (backup: SelfBackupInfo) => {
    setSelectedBackup(backup);
    setErrorDialogOpen(true);
  };

  // Loading state
  if (isLoadingConfig || isLoadingContainers) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-96" />
            </div>
          </div>
        </div>
        <div className="px-4 lg:px-6 max-w-7xl">
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    );
  }

  const config = configData?.config;
  const scheduleInfo = configData?.scheduleInfo;
  const containers = azureData?.data?.containers || [];

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconDatabase className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Self-Backup Settings</h1>
            <p className="text-muted-foreground">
              Configure automated backups of the Mini Infra database to Azure Blob Storage
            </p>
          </div>
        </div>

        {/* Azure Storage Check */}
        {!isAzureConnected && (
          <Alert>
            <IconAlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>
                Azure Blob Storage is required for self-backups. Please configure
                Azure Storage settings first.
              </span>
              <Button asChild variant="outline" size="sm">
                <Link to="/connectivity/azure">Configure Azure</Link>
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Configuration Form */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
        <CardHeader>
          <CardTitle>Backup Configuration</CardTitle>
          <CardDescription>
            Configure backup schedule, storage location, and timezone
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {/* Azure Container */}
              <FormField
                control={form.control}
                name="azureContainerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Azure Storage Container</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={!isAzureConnected || containers.length === 0}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a container" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {containers.map((container) => (
                          <SelectItem key={container.name} value={container.name}>
                            {container.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      The Azure container where backups will be stored
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Cron Schedule */}
              <FormField
                control={form.control}
                name="cronSchedule"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Backup Schedule</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="0 * * * *"
                        disabled={!isAzureConnected}
                      />
                    </FormControl>
                    <FormDescription>
                      Cron expression for backup schedule (e.g., "0 * * * *" for
                      hourly)
                    </FormDescription>
                    <FormMessage />
                    {/* Quick presets */}
                    <div className="flex flex-wrap gap-2 mt-2">
                      {cronPresets.map((preset) => (
                        <Button
                          key={preset.value}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => field.onChange(preset.value)}
                          disabled={!isAzureConnected}
                          title={preset.description}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </FormItem>
                )}
              />

              {/* Timezone */}
              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Timezone</FormLabel>
                    <Popover
                      open={timezonePopoverOpen}
                      onOpenChange={setTimezonePopoverOpen}
                    >
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            role="combobox"
                            disabled={!isAzureConnected}
                            className={cn(
                              "w-full justify-between",
                              !field.value && "text-muted-foreground",
                            )}
                          >
                            {field.value
                              ? timezones?.find(
                                  (timezone) => timezone.value === field.value,
                                )?.label
                              : "Select a timezone"}
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-[400px] max-w-[400px] p-0"
                        align="start"
                      >
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
                                        : "opacity-0",
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
                      Timezone for the backup schedule. Current time:{" "}
                      {form.watch("timezone") &&
                        new Date().toLocaleString("en-US", {
                          timeZone: form.watch("timezone") || "UTC",
                          dateStyle: "short",
                          timeStyle: "medium",
                        })}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Schedule Status */}
              {scheduleInfo && (
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <div className="text-sm font-medium">
                        Scheduled Backups
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {config?.enabled
                          ? "Automatic backups are enabled"
                          : "Automatic backups are disabled"}
                      </div>
                    </div>
                    <Switch
                      checked={config?.enabled || false}
                      onCheckedChange={handleToggleEnabled}
                      disabled={
                        !isAzureConnected ||
                        enableBackup.isPending ||
                        disableBackup.isPending
                      }
                    />
                  </div>

                  {scheduleInfo.nextScheduledAt && config?.enabled && (
                    <div className="flex items-center gap-2 text-sm">
                      <IconClock className="h-4 w-4 text-muted-foreground" />
                      <span>
                        Next backup:{" "}
                        {new Date(scheduleInfo.nextScheduledAt).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  disabled={
                    !isAzureConnected ||
                    !form.formState.isDirty ||
                    updateConfig.isPending
                  }
                >
                  <IconDeviceFloppy className="mr-2 h-4 w-4" />
                  {updateConfig.isPending
                    ? "Saving..."
                    : "Save Configuration"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTriggerBackup}
                  disabled={
                    !isAzureConnected ||
                    !config?.azureContainerName ||
                    triggerBackup.isPending
                  }
                >
                  {triggerBackup.isPending ? (
                    <>
                      <IconRefresh className="mr-2 h-4 w-4 animate-spin" />
                      Backing up...
                    </>
                  ) : (
                    <>
                      <IconPlayerPlay className="mr-2 h-4 w-4" />
                      Backup Now
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
      </div>

      {/* Backup History */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Backup History</CardTitle>
              <CardDescription>
                View past backup operations and their status
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchHistory()}
              >
                <IconRefresh className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingHistory ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : historyData?.backups && historyData.backups.length > 0 ? (
            <div className="space-y-4">
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started At</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>File Name</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Triggered By</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyData.backups.map((backup) => (
                      <BackupHistoryRow
                        key={backup.id}
                        backup={backup}
                        onViewError={handleViewError}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {historyData.pagination.totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">
                    Page {page} of {historyData.pagination.totalPages} (
                    {historyData.pagination.total} total)
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPage((p) =>
                          Math.min(historyData.pagination.totalPages, p + 1)
                        )
                      }
                      disabled={page === historyData.pagination.totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12">
              <IconDatabase className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No backups yet</h3>
              <p className="text-muted-foreground">
                {statusFilter !== "all"
                  ? "No backups match your filter"
                  : "Configure and enable backups to get started"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      {/* Error Details Dialog */}
      <ErrorDetailsDialog
        backup={selectedBackup}
        open={errorDialogOpen}
        onOpenChange={setErrorDialogOpen}
      />
    </div>
  );
}

// Backup history row component
function BackupHistoryRow({
  backup,
  onViewError,
}: {
  backup: SelfBackupInfo;
  onViewError: (backup: SelfBackupInfo) => void;
}) {
  const formatStartedAt = useFormattedDateTime(
    backup.startedAt ? new Date(backup.startedAt) : null
  );

  return (
    <TableRow>
      <TableCell className="font-medium">{formatStartedAt}</TableCell>
      <TableCell>
        <Badge
          variant={
            backup.status === "completed"
              ? "default"
              : backup.status === "failed"
                ? "destructive"
                : "secondary"
          }
        >
          {backup.status === "completed" && (
            <IconCircleCheck className="mr-1 h-3 w-3" />
          )}
          {backup.status === "failed" && (
            <IconCircleX className="mr-1 h-3 w-3" />
          )}
          {backup.status === "in_progress" && (
            <IconRefresh className="mr-1 h-3 w-3 animate-spin" />
          )}
          {backup.status}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-sm">{backup.fileName}</TableCell>
      <TableCell>
        {backup.fileSize ? formatBytes(backup.fileSize) : "—"}
      </TableCell>
      <TableCell>
        {backup.durationMs ? formatDuration(backup.durationMs) : "—"}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{backup.triggeredBy}</Badge>
      </TableCell>
      <TableCell>
        {backup.status === "failed" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewError(backup)}
          >
            <IconAlertTriangle className="mr-1 h-3 w-3" />
            View Error
          </Button>
        )}
        {backup.status === "completed" && backup.azureBlobUrl && (
          <Button variant="ghost" size="sm" asChild>
            <a href={`/api/self-backups/${backup.id}/download`}>
              <IconDownload className="mr-1 h-3 w-3" />
              Download
            </a>
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
