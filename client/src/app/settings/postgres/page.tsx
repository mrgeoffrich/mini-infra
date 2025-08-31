import { useState } from "react";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  usePostgresDatabases,
  useCreatePostgresDatabase,
  useUpdatePostgresDatabase,
  useDeletePostgresDatabase,
  useTestDatabaseConnection,
  useTestExistingDatabaseConnection,
  usePostgresDatabaseFilters,
} from "@/hooks/use-postgres-databases";
import {
  usePostgresBackupConfig,
  useCreatePostgresBackupConfig,
  useUpdatePostgresBackupConfig,
  useDeletePostgresBackupConfig,
} from "@/hooks/use-postgres-backup-configs";
import { useCreateManualBackup } from "@/hooks/use-postgres-backup-operations";
import {
  useAvailableBackups,
  useCreateRestoreOperation,
  usePostgresRestoreOperations,
  useBackupBrowserFilters,
  usePostgresRestoreOperationFilters,
} from "@/hooks/use-postgres-restore-operations";
import {
  Database,
  CheckCircle,
  XCircle,
  AlertCircle,
  ArrowLeft,
  TestTube,
  Loader2,
  Eye,
  EyeOff,
  Plus,
  Pencil,
  Trash2,
  Calendar,
  Play,
  Clock,
  Save,
  Download,
  RefreshCw,
  Search,
  History,
  Undo,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import type {
  PostgresDatabaseInfo,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  DatabaseHealthStatus,
  PostgreSSLMode,
  BackupConfigurationInfo,
  CreateBackupConfigurationRequest,
  UpdateBackupConfigurationRequest,
  BackupBrowserItem,
  CreateRestoreOperationRequest,
  RestoreOperationStatus,
} from "@mini-infra/types";

const postgresDbSchema = z.object({
  name: z
    .string()
    .min(1, "Database name is required")
    .max(255, "Database name must be less than 255 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Database name can only contain letters, numbers, underscores, and hyphens",
    ),
  host: z
    .string()
    .min(1, "Host is required")
    .max(255, "Host must be less than 255 characters"),
  port: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  database: z
    .string()
    .min(1, "Database name is required")
    .max(255, "Database name must be less than 255 characters"),
  username: z
    .string()
    .min(1, "Username is required")
    .max(255, "Username must be less than 255 characters"),
  password: z
    .string()
    .min(1, "Password is required")
    .max(255, "Password must be less than 255 characters"),
  sslMode: z.enum(["require", "disable", "prefer"]),
  tags: z.array(z.string()),
});

type PostgresDbFormData = z.infer<typeof postgresDbSchema>;

const backupConfigSchema = z.object({
  schedule: z.string().optional(),
  azureContainerName: z
    .string()
    .min(1, "Azure container name is required")
    .max(255, "Container name must be less than 255 characters"),
  azurePathPrefix: z.string().optional(),
  retentionDays: z
    .number()
    .int()
    .min(1, "Retention must be at least 1 day")
    .max(365, "Retention cannot exceed 365 days"),
  backupFormat: z.enum(["custom", "plain", "tar"]),
  compressionLevel: z
    .number()
    .int()
    .min(0, "Compression level must be between 0-9")
    .max(9, "Compression level must be between 0-9"),
  isEnabled: z.boolean(),
});

type BackupConfigFormData = z.infer<typeof backupConfigSchema>;

function HealthStatusBadge({ status }: { status: DatabaseHealthStatus }) {
  switch (status) {
    case "healthy":
      return (
        <Badge variant="outline" className="text-green-700 border-green-200">
          <CheckCircle className="w-3 h-3 mr-1" />
          Healthy
        </Badge>
      );
    case "unhealthy":
      return (
        <Badge variant="outline" className="text-red-700 border-red-200">
          <XCircle className="w-3 h-3 mr-1" />
          Unhealthy
        </Badge>
      );
    case "unknown":
    default:
      return (
        <Badge variant="outline" className="text-gray-700 border-gray-200">
          <AlertCircle className="w-3 h-3 mr-1" />
          Unknown
        </Badge>
      );
  }
}

function BackupStatusDisplay({ database }: { database: PostgresDatabaseInfo }) {
  const { data: backupConfigResponse, isLoading } = usePostgresBackupConfig(
    database.id,
  );

  const backupConfig = backupConfigResponse?.data;

  if (isLoading) {
    return <Skeleton className="h-4 w-20" />;
  }

  if (!backupConfig) {
    return (
      <Badge variant="outline" className="text-gray-700 border-gray-200">
        <AlertCircle className="w-3 h-3 mr-1" />
        Not Configured
      </Badge>
    );
  }

  if (!backupConfig.isEnabled) {
    return (
      <Badge variant="outline" className="text-yellow-700 border-yellow-200">
        <Clock className="w-3 h-3 mr-1" />
        Disabled
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-green-700 border-green-200">
      <Calendar className="w-3 h-3 mr-1" />
      Scheduled
    </Badge>
  );
}

function DatabaseModal({
  database,
  isOpen,
  onClose,
}: {
  database?: PostgresDatabaseInfo;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const isEditing = !!database;

  const createMutation = useCreatePostgresDatabase();
  const updateMutation = useUpdatePostgresDatabase();
  const testConnectionMutation = useTestDatabaseConnection();

  const form = useForm<PostgresDbFormData>({
    resolver: zodResolver(postgresDbSchema),
    defaultValues: {
      name: database?.name || "",
      host: database?.host || "",
      port: database?.port || 5432,
      database: database?.database || "",
      username: database?.username || "",
      password: "",
      sslMode: (database?.sslMode as PostgreSSLMode) || "prefer",
      tags: database?.tags || [],
    },
    mode: "onChange",
  });

  const onSubmit = async (data: PostgresDbFormData) => {
    try {
      if (isEditing) {
        const updateData: UpdatePostgresDatabaseRequest = {
          ...data,
          password: data.password || undefined,
        };
        await updateMutation.mutateAsync({
          id: database.id,
          request: updateData,
        });
        toast.success("Database updated successfully");
      } else {
        const createData: CreatePostgresDatabaseRequest = data;
        await createMutation.mutateAsync(createData);
        toast.success("Database created successfully");
      }
      onClose();
    } catch (error) {
      toast.error(
        `Failed to ${isEditing ? "update" : "create"} database: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const testConnection = async () => {
    const formData = form.getValues();
    if (!formData.password && isEditing) {
      toast.error("Password is required to test connection");
      return;
    }

    try {
      const testData = {
        host: formData.host,
        port: formData.port,
        database: formData.database,
        username: formData.username,
        password: formData.password,
        sslMode: formData.sslMode,
      };
      const result = await testConnectionMutation.mutateAsync(testData);
      if (result.data.isConnected) {
        toast.success("Connection test successful!");
      } else {
        toast.error(
          `Connection test failed: ${result.data.error || result.message}`,
        );
      }
    } catch (error) {
      toast.error(
        `Connection test failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Database" : "Add New Database"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the database configuration."
              : "Add a new PostgreSQL database configuration."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Database Name</FormLabel>
                    <FormControl>
                      <Input placeholder="my-database" {...field} />
                    </FormControl>
                    <FormDescription>
                      A unique name for this database configuration
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sslMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>SSL Mode</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select SSL mode" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="require">Require</SelectItem>
                        <SelectItem value="prefer">Prefer</SelectItem>
                        <SelectItem value="disable">Disable</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <FormField
                  control={form.control}
                  name="host"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Host</FormLabel>
                      <FormControl>
                        <Input placeholder="localhost" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="5432"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="database"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Database</FormLabel>
                    <FormControl>
                      <Input placeholder="postgres" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
                    <FormControl>
                      <Input placeholder="postgres" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Password {isEditing && "(leave empty to keep current)"}
                  </FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder={
                          isEditing ? "Enter new password" : "Enter password"
                        }
                        {...field}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex items-center space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={testConnection}
                disabled={testConnectionMutation.isPending}
              >
                {testConnectionMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="w-4 h-4 mr-2" />
                )}
                Test Connection
              </Button>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  createMutation.isPending ||
                  updateMutation.isPending ||
                  testConnectionMutation.isPending
                }
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                {isEditing ? "Update" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function BackupConfigurationModal({
  database,
  backupConfig,
  isOpen,
  onClose,
}: {
  database: PostgresDatabaseInfo;
  backupConfig?: BackupConfigurationInfo | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const isEditing = !!backupConfig;

  const createMutation = useCreatePostgresBackupConfig();
  const updateMutation = useUpdatePostgresBackupConfig();
  const deleteMutation = useDeletePostgresBackupConfig();
  const manualBackupMutation = useCreateManualBackup();

  const form = useForm<BackupConfigFormData>({
    resolver: zodResolver(backupConfigSchema),
    defaultValues: {
      schedule: backupConfig?.schedule || "0 2 * * *", // Daily at 2 AM
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
      toast.error(
        `Failed to ${isEditing ? "update" : "create"} backup configuration: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
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
        }`,
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
        }`,
      );
    }
  };

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

            {/* Next Scheduled Time */}
            {backupConfig?.nextScheduledAt && form.watch("isEnabled") && (
              <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                <Clock className="w-4 h-4" />
                <span>
                  Next backup scheduled for:{" "}
                  {format(
                    new Date(backupConfig.nextScheduledAt),
                    "MMM d, yyyy HH:mm",
                  )}
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              {/* Azure Container */}
              <FormField
                control={form.control}
                name="azureContainerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Azure Container Name</FormLabel>
                    <FormControl>
                      <Input placeholder="postgres-backups" {...field} />
                    </FormControl>
                    <FormDescription>
                      Azure Storage container for backups
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
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
                    {format(
                      new Date(backupConfig.lastBackupAt),
                      "MMM d, yyyy HH:mm",
                    )}
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

function RestoreOperationStatusBadge({
  status,
}: {
  status: RestoreOperationStatus;
}) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="outline" className="text-green-700 border-green-200">
          <CheckCircle className="w-3 h-3 mr-1" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="text-red-700 border-red-200">
          <XCircle className="w-3 h-3 mr-1" />
          Failed
        </Badge>
      );
    case "running":
      return (
        <Badge variant="outline" className="text-blue-700 border-blue-200">
          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          Running
        </Badge>
      );
    case "pending":
    default:
      return (
        <Badge variant="outline" className="text-yellow-700 border-yellow-200">
          <Clock className="w-3 h-3 mr-1" />
          Pending
        </Badge>
      );
  }
}

function RestoreBrowserModal({
  database,
  isOpen,
  onClose,
}: {
  database: PostgresDatabaseInfo;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [selectedBackup, setSelectedBackup] =
    useState<BackupBrowserItem | null>(null);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"browse" | "history">("browse");

  const { filters: backupFilters } = useBackupBrowserFilters();
  const { filters: restoreFilters } = usePostgresRestoreOperationFilters();

  // Get backup configuration to determine container name
  const { data: backupConfigResponse } = usePostgresBackupConfig(database.id);
  const backupConfig = backupConfigResponse?.data;
  const containerName = backupConfig?.azureContainerName || "postgres-backups";

  // Fetch available backups
  const {
    data: backupsResponse,
    isLoading: backupsLoading,
    error: backupsError,
    refetch: refetchBackups,
  } = useAvailableBackups(containerName, {
    filters: {
      createdAfter: backupFilters.createdAfter?.toISOString(),
      createdBefore: backupFilters.createdBefore?.toISOString(),
      sizeMin: backupFilters.sizeMin,
      sizeMax: backupFilters.sizeMax,
    },
    page: backupFilters.page,
    limit: backupFilters.limit,
    sortBy: backupFilters.sortBy,
    sortOrder: backupFilters.sortOrder,
    enabled: isOpen && !!backupConfig,
  });

  // Fetch restore operations history
  const {
    data: restoreOpsResponse,
    isLoading: restoreOpsLoading,
    error: restoreOpsError,
  } = usePostgresRestoreOperations(database.id, {
    filters: {
      status: restoreFilters.status,
      startedAfter: restoreFilters.startedAfter?.toISOString(),
      startedBefore: restoreFilters.startedBefore?.toISOString(),
    },
    page: restoreFilters.page,
    limit: restoreFilters.limit,
    sortBy: restoreFilters.sortBy,
    sortOrder: restoreFilters.sortOrder,
    enabled: isOpen,
  });

  const createRestoreMutation = useCreateRestoreOperation();

  const backups = backupsResponse?.data || [];
  const restoreOperations = restoreOpsResponse?.data || [];

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const handleRestoreConfirm = async () => {
    if (!selectedBackup) return;

    try {
      const request: CreateRestoreOperationRequest = {
        databaseId: database.id,
        backupUrl: selectedBackup.url,
      };

      await createRestoreMutation.mutateAsync(request);
      toast.success(`Restore operation started for ${database.name}`);
      setConfirmRestoreOpen(false);
      setSelectedBackup(null);
      setActiveTab("history"); // Switch to history tab to show progress
    } catch (error) {
      toast.error(
        `Failed to start restore operation: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Restore Database: {database.name}</DialogTitle>
            <DialogDescription>
              Browse available backups and manage restore operations
            </DialogDescription>
          </DialogHeader>

          {/* Tabs */}
          <div className="flex space-x-1 p-1 bg-muted rounded-lg">
            <button
              onClick={() => setActiveTab("browse")}
              className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === "browse"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Search className="w-4 h-4 mr-2 inline" />
              Browse Backups
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === "history"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <History className="w-4 h-4 mr-2 inline" />
              Restore History
            </button>
          </div>

          {/* Browse Backups Tab */}
          {activeTab === "browse" && (
            <div className="space-y-4">
              {!backupConfig && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    No backup configuration found. Please configure backup
                    settings first.
                  </AlertDescription>
                </Alert>
              )}

              {backupConfig && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                      Container:{" "}
                      <span className="font-mono">{containerName}</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refetchBackups()}
                      disabled={backupsLoading}
                    >
                      {backupsLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      Refresh
                    </Button>
                  </div>

                  {/* Backup List */}
                  {backupsError && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        Failed to load backups: {backupsError.message}
                      </AlertDescription>
                    </Alert>
                  )}

                  {backupsLoading ? (
                    <div className="space-y-2">
                      {[...Array(3)].map((_, i) => (
                        <div
                          key={i}
                          className="flex items-center space-x-4 p-4 border rounded"
                        >
                          <Skeleton className="h-4 w-4" />
                          <Skeleton className="h-4 w-[200px]" />
                          <Skeleton className="h-4 w-[100px]" />
                          <Skeleton className="h-4 w-[150px]" />
                        </div>
                      ))}
                    </div>
                  ) : backups.length === 0 ? (
                    <div className="text-center py-8">
                      <Database className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                      <h3 className="text-lg font-semibold mb-2">
                        No backups found
                      </h3>
                      <p className="text-muted-foreground">
                        No backup files were found in the configured Azure
                        container.
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead>Size</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {backups.map((backup) => (
                          <TableRow key={backup.url}>
                            <TableCell className="font-mono text-sm">
                              {backup.name}
                            </TableCell>
                            <TableCell>
                              {format(
                                new Date(backup.createdAt),
                                "MMM d, yyyy HH:mm",
                              )}
                            </TableCell>
                            <TableCell>
                              {formatBytes(backup.sizeBytes)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setSelectedBackup(backup);
                                  setConfirmRestoreOpen(true);
                                }}
                                disabled={createRestoreMutation.isPending}
                              >
                                <Undo className="w-4 h-4 mr-2" />
                                Restore
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </>
              )}
            </div>
          )}

          {/* Restore History Tab */}
          {activeTab === "history" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Restore operations for {database.name}
                </div>
              </div>

              {restoreOpsError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    Failed to load restore operations: {restoreOpsError.message}
                  </AlertDescription>
                </Alert>
              )}

              {restoreOpsLoading ? (
                <div className="space-y-2">
                  {[...Array(3)].map((_, i) => (
                    <div
                      key={i}
                      className="flex items-center space-x-4 p-4 border rounded"
                    >
                      <Skeleton className="h-4 w-[100px]" />
                      <Skeleton className="h-4 w-[150px]" />
                      <Skeleton className="h-4 w-[200px]" />
                      <Skeleton className="h-4 w-[80px]" />
                    </div>
                  ))}
                </div>
              ) : restoreOperations.length === 0 ? (
                <div className="text-center py-8">
                  <History className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                  <h3 className="text-lg font-semibold mb-2">
                    No restore operations
                  </h3>
                  <p className="text-muted-foreground">
                    No restore operations have been performed for this database
                    yet.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Backup URL</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {restoreOperations.map((operation) => (
                      <TableRow key={operation.id}>
                        <TableCell>
                          {format(
                            new Date(operation.startedAt),
                            "MMM d, yyyy HH:mm",
                          )}
                        </TableCell>
                        <TableCell>
                          <RestoreOperationStatusBadge
                            status={operation.status}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs max-w-[200px] truncate">
                          {operation.backupUrl}
                        </TableCell>
                        <TableCell>
                          {operation.completedAt
                            ? `${Math.round(
                                (new Date(operation.completedAt).getTime() -
                                  new Date(operation.startedAt).getTime()) /
                                  1000,
                              )}s`
                            : "-"}
                        </TableCell>
                        <TableCell className="max-w-[150px] truncate text-xs text-red-600">
                          {operation.errorMessage || "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Confirmation Dialog */}
      <AlertDialog
        open={confirmRestoreOpen}
        onOpenChange={setConfirmRestoreOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Database Restore</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to restore the database "{database.name}"
              from the backup:
              <br />
              <br />
              <code className="text-sm bg-muted px-2 py-1 rounded">
                {selectedBackup?.name}
              </code>
              <br />
              <br />
              <strong className="text-red-600">
                This will completely replace all data in the target database.
                This action cannot be undone.
              </strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmRestoreOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestoreConfirm}
              disabled={createRestoreMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {createRestoreMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Restore Database
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function PostgresSettingsPage() {
  const [selectedDatabase, setSelectedDatabase] =
    useState<PostgresDatabaseInfo | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [databaseToDelete, setDatabaseToDelete] =
    useState<PostgresDatabaseInfo | null>(null);
  const [backupConfigModalOpen, setBackupConfigModalOpen] = useState(false);
  const [selectedBackupDatabase, setSelectedBackupDatabase] =
    useState<PostgresDatabaseInfo | null>(null);
  const [restoreBrowserModalOpen, setRestoreBrowserModalOpen] = useState(false);
  const [selectedRestoreDatabase, setSelectedRestoreDatabase] =
    useState<PostgresDatabaseInfo | null>(null);

  // Get backup config for selected database (always call hook, even if database is null)
  const { data: selectedBackupConfigResponse } = usePostgresBackupConfig(
    selectedBackupDatabase?.id || "",
  );

  const selectedBackupConfig = selectedBackupDatabase
    ? selectedBackupConfigResponse?.data
    : null;

  const { filters } = usePostgresDatabaseFilters();

  const {
    data: databasesResponse,
    isLoading,
    error,
  } = usePostgresDatabases({
    filters: {
      name: filters.name,
      host: filters.host,
      healthStatus: filters.healthStatus,
      tags: filters.tags,
    },
    page: filters.page,
    limit: filters.limit,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  const deleteMutation = useDeletePostgresDatabase();
  const testExistingMutation = useTestExistingDatabaseConnection();

  const databases = databasesResponse?.data || [];

  const openCreateModal = () => {
    setSelectedDatabase(null);
    setIsModalOpen(true);
  };

  const openBackupConfigModal = (database: PostgresDatabaseInfo) => {
    setSelectedBackupDatabase(database);
    setBackupConfigModalOpen(true);
  };

  const closeBackupConfigModal = () => {
    setBackupConfigModalOpen(false);
    setSelectedBackupDatabase(null);
  };

  const openRestoreBrowserModal = (database: PostgresDatabaseInfo) => {
    setSelectedRestoreDatabase(database);
    setRestoreBrowserModalOpen(true);
  };

  const closeRestoreBrowserModal = () => {
    setRestoreBrowserModalOpen(false);
    setSelectedRestoreDatabase(null);
  };

  const openEditModal = (database: PostgresDatabaseInfo) => {
    setSelectedDatabase(database);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setSelectedDatabase(null);
  };

  const openDeleteDialog = (database: PostgresDatabaseInfo) => {
    setDatabaseToDelete(database);
    setIsDeleteDialogOpen(true);
  };

  const closeDeleteDialog = () => {
    setIsDeleteDialogOpen(false);
    setDatabaseToDelete(null);
  };

  const confirmDelete = async () => {
    if (!databaseToDelete) return;

    try {
      await deleteMutation.mutateAsync(databaseToDelete.id);
      toast.success("Database deleted successfully");
      closeDeleteDialog();
    } catch (error) {
      toast.error(
        `Failed to delete database: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const testExistingConnection = async (database: PostgresDatabaseInfo) => {
    try {
      const result = await testExistingMutation.mutateAsync(database.id);
      if (result.data.isConnected) {
        toast.success(`Connection test successful for ${database.name}!`);
      } else {
        toast.error(
          `Connection test failed for ${database.name}: ${result.data.error || result.message}`,
        );
      }
    } catch (error) {
      toast.error(
        `Connection test failed for ${database.name}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  if (error) {
    return (
      <div className="container mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-8">
          <Link
            to="/settings"
            className="flex items-center text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Settings
          </Link>
        </div>

        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load PostgreSQL databases: {error.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center gap-4 mb-8">
        <Link
          to="/settings"
          className="flex items-center text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Settings
        </Link>
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">PostgreSQL Management</h1>
            <p className="text-muted-foreground">
              Configure and manage PostgreSQL database connections
            </p>
          </div>
          <Button onClick={openCreateModal}>
            <Plus className="w-4 h-4 mr-2" />
            Add Database
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Database className="w-5 h-5 mr-2" />
              Database Connections
            </CardTitle>
            <CardDescription>
              Manage your PostgreSQL database configurations and monitor their
              health status
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center space-x-4">
                    <Skeleton className="h-12 w-12" />
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-[200px]" />
                      <Skeleton className="h-4 w-[150px]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : databases.length === 0 ? (
              <div className="text-center py-8">
                <Database className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-semibold mb-2">
                  No databases configured
                </h3>
                <p className="text-muted-foreground mb-4">
                  Get started by adding your first PostgreSQL database
                  connection
                </p>
                <Button onClick={openCreateModal}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Database
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Database</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Backup Status</TableHead>
                    <TableHead>Last Check</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {databases.map((database) => (
                    <TableRow key={database.id}>
                      <TableCell className="font-medium">
                        {database.name}
                      </TableCell>
                      <TableCell>
                        {database.host}:{database.port}
                      </TableCell>
                      <TableCell>{database.database}</TableCell>
                      <TableCell>
                        <HealthStatusBadge status={database.healthStatus} />
                      </TableCell>
                      <TableCell>
                        <BackupStatusDisplay database={database} />
                      </TableCell>
                      <TableCell>
                        {database.lastHealthCheck
                          ? format(
                              new Date(database.lastHealthCheck),
                              "MMM d, yyyy HH:mm",
                            )
                          : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => testExistingConnection(database)}
                            disabled={testExistingMutation.isPending}
                            title="Test Connection"
                          >
                            {testExistingMutation.isPending ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <TestTube className="w-4 h-4" />
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openBackupConfigModal(database)}
                            title="Configure Backup"
                          >
                            <Calendar className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openRestoreBrowserModal(database)}
                            title="Browse Backups & Restore"
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditModal(database)}
                            title="Edit Database"
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openDeleteDialog(database)}
                            title="Delete Database"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <DatabaseModal
        database={selectedDatabase || undefined}
        isOpen={isModalOpen}
        onClose={closeModal}
      />

      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the database configuration for "
              {databaseToDelete?.name}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={closeDeleteDialog}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {selectedBackupDatabase && (
        <BackupConfigurationModal
          database={selectedBackupDatabase}
          backupConfig={selectedBackupConfig}
          isOpen={backupConfigModalOpen}
          onClose={closeBackupConfigModal}
        />
      )}

      {selectedRestoreDatabase && (
        <RestoreBrowserModal
          database={selectedRestoreDatabase}
          isOpen={restoreBrowserModalOpen}
          onClose={closeRestoreBrowserModal}
        />
      )}
    </div>
  );
}
