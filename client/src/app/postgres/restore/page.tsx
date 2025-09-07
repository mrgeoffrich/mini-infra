import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  useAvailableBackups,
  useCreateRestoreOperation,
  usePostgresRestoreOperations,
  useBackupBrowserFilters,
  usePostgresRestoreOperationFilters,
} from "@/hooks/use-postgres-restore-operations";
import { usePostgresBackupConfig } from "@/hooks/use-postgres-backup-configs";
import { usePostgresDatabases } from "@/hooks/use-postgres-databases";
import {
  Database,
  AlertCircle,
  Loader2,
  RefreshCw,
  Search,
  History,
  Undo,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { RestoreOperationStatusBadge } from "@/components/postgres/status-badges";
import type {
  PostgresDatabaseInfo,
  BackupBrowserItem,
  CreateRestoreOperationRequest,
} from "@mini-infra/types";

export default function PostgresRestorePage() {
  const { databaseId } = useParams<{ databaseId: string }>();
  const navigate = useNavigate();
  const [selectedBackup, setSelectedBackup] =
    useState<BackupBrowserItem | null>(null);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"browse" | "history">("browse");
  const [restoreDestination, setRestoreDestination] = useState<"overwrite" | "new">("overwrite");
  const [newDatabaseName, setNewDatabaseName] = useState("");

  // Get database info
  const { data: databasesResponse } = usePostgresDatabases({
    filters: {},
    page: 1,
    limit: 1000, // Get all to find the specific database
  });

  const database = databasesResponse?.data?.find(
    (db) => db.id === databaseId
  ) as PostgresDatabaseInfo | undefined;

  const { filters: backupFilters } = useBackupBrowserFilters();
  const { filters: restoreFilters } = usePostgresRestoreOperationFilters();

  // Get backup configuration to determine container name
  const { data: backupConfigResponse } = usePostgresBackupConfig(databaseId || "");
  const backupConfig = backupConfigResponse?.data;
  const containerName = backupConfig?.azureContainerName || "postgres-backups";

  // Fetch available backups
  const {
    data: backupsResponse,
    isLoading: backupsLoading,
    error: backupsError,
    refetch: refetchBackups,
  } = useAvailableBackups(containerName, databaseId || "", {
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
    enabled: !!databaseId && !!backupConfig,
  });

  // Fetch restore operations history
  const {
    data: restoreOpsResponse,
    isLoading: restoreOpsLoading,
    error: restoreOpsError,
  } = usePostgresRestoreOperations(databaseId || "", {
    filters: {
      status: restoreFilters.status,
      startedAfter: restoreFilters.startedAfter?.toISOString(),
      startedBefore: restoreFilters.startedBefore?.toISOString(),
    },
    page: restoreFilters.page,
    limit: restoreFilters.limit,
    sortBy: restoreFilters.sortBy,
    sortOrder: restoreFilters.sortOrder,
    enabled: !!databaseId,
  });

  const createRestoreMutation = useCreateRestoreOperation();

  const backups = backupsResponse?.data || [];
  const restoreOperations = restoreOpsResponse?.data || [];

  // Redirect if no database ID
  useEffect(() => {
    if (!databaseId) {
      navigate("/postgres");
    }
  }, [databaseId, navigate]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const handleRestoreConfirm = async () => {
    if (!selectedBackup || !database) return;

    try {
      let targetDatabaseName = database.name;

      // For new database restore, we'll pass the flag to the backend
      // The backend will handle creating a new database configuration
      if (restoreDestination === "new") {
        if (!newDatabaseName.trim()) {
          toast.error("Please provide a name for the new database");
          return;
        }
        targetDatabaseName = newDatabaseName;
      }

      const request: CreateRestoreOperationRequest = {
        databaseId: database.id, // Always use the source database ID
        backupUrl: selectedBackup.url,
        confirmRestore: true, // Required by backend for confirmation
        restoreToNewDatabase: restoreDestination === "new",
        newDatabaseName: restoreDestination === "new" ? newDatabaseName : undefined,
      };

      await createRestoreMutation.mutateAsync(request);
      toast.success(
        restoreDestination === "new"
          ? `Restore operation started for new database: ${targetDatabaseName}`
          : `Restore operation started for ${targetDatabaseName}`
      );
      setConfirmRestoreOpen(false);
      setSelectedBackup(null);
      setRestoreDestination("overwrite");
      setNewDatabaseName("");
      setActiveTab("history"); // Switch to history tab to show progress
    } catch (error) {
      toast.error(
        `Failed to start restore operation: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  };

  if (!database) {
    return (
      <div className="container mx-auto px-6 py-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Database not found. Please check the URL and try again.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="space-y-6">
        {/* Breadcrumb Navigation */}
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/postgres">PostgreSQL</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{database.name}</BreadcrumbPage>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Restore</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        {/* Page Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/postgres")}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to PostgreSQL
          </Button>
          <div>
            <h1 className="text-3xl font-bold">Restore Database</h1>
            <p className="text-muted-foreground">
              Browse available backups and restore {database.name}
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Database className="w-5 h-5 mr-2" />
              Database: {database.name}
            </CardTitle>
            <CardDescription>
              Host: {database.host}:{database.port}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Tabs */}
            <div className="flex space-x-1 p-1 bg-muted rounded-lg mb-6">
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
                        {[...Array(5)].map((_, i) => (
                          <div
                            key={i}
                            className="flex items-center space-x-4 p-4 border rounded"
                          >
                            <Skeleton className="h-4 w-4" />
                            <Skeleton className="h-4 w-[300px]" />
                            <Skeleton className="h-4 w-[150px]" />
                            <Skeleton className="h-4 w-[100px]" />
                            <Skeleton className="h-4 w-[80px]" />
                          </div>
                        ))}
                      </div>
                    ) : backups.length === 0 ? (
                      <div className="text-center py-12">
                        <Database className="w-16 h-16 mx-auto mb-4 text-muted-foreground" />
                        <h3 className="text-xl font-semibold mb-2">
                          No backups found
                        </h3>
                        <p className="text-muted-foreground">
                          No backup files were found in the configured Azure
                          container for this database.
                        </p>
                      </div>
                    ) : (
                      <div className="border rounded-md">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Backup Name</TableHead>
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
                                    "MMM d, yyyy HH:mm"
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
                      </div>
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
                  <div className="text-center py-12">
                    <History className="w-16 h-16 mx-auto mb-4 text-muted-foreground" />
                    <h3 className="text-xl font-semibold mb-2">
                      No restore operations
                    </h3>
                    <p className="text-muted-foreground">
                      No restore operations have been performed for this database
                      yet.
                    </p>
                  </div>
                ) : (
                  <div className="border rounded-md">
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
                                "MMM d, yyyy HH:mm"
                              )}
                            </TableCell>
                            <TableCell>
                              <RestoreOperationStatusBadge
                                status={operation.status}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs max-w-[300px]">
                              <div className="truncate" title={operation.backupUrl}>
                                {operation.backupUrl}
                              </div>
                            </TableCell>
                            <TableCell>
                              {operation.completedAt
                                ? `${Math.round(
                                    (new Date(operation.completedAt).getTime() -
                                      new Date(operation.startedAt).getTime()) /
                                      1000
                                  )}s`
                                : "-"}
                            </TableCell>
                            <TableCell className="max-w-[200px]">
                              {operation.errorMessage ? (
                                <div
                                  className="truncate text-xs text-red-600"
                                  title={operation.errorMessage}
                                >
                                  {operation.errorMessage}
                                </div>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Restore Confirmation Dialog */}
      <AlertDialog
        open={confirmRestoreOpen}
        onOpenChange={setConfirmRestoreOpen}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Database Restore</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to restore the database from the following backup:
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          {/* Backup File Preview */}
          {selectedBackup && (
            <div className="bg-muted/50 p-4 rounded-lg border space-y-3">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">Backup File</div>
                  <code className="text-xs bg-muted px-2 py-1 rounded">
                    {selectedBackup.name}
                  </code>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div className="space-y-1">
                  <div className="text-muted-foreground">Created</div>
                  <div className="font-mono">
                    {format(new Date(selectedBackup.createdAt), "MMM d, yyyy")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(selectedBackup.createdAt), "HH:mm:ss")}
                  </div>
                </div>
                
                <div className="space-y-1">
                  <div className="text-muted-foreground">File Size</div>
                  <div className="font-mono">{formatBytes(selectedBackup.sizeBytes)}</div>
                  <div className="text-xs text-muted-foreground">
                    {selectedBackup.sizeBytes.toLocaleString()} bytes
                  </div>
                </div>
              </div>
              
              {/* Age and estimated restore time */}
              <div className="flex justify-between text-xs text-muted-foreground">
                <div>
                  {(() => {
                    const ageInMs = Date.now() - new Date(selectedBackup.createdAt).getTime();
                    const ageInDays = Math.floor(ageInMs / (1000 * 60 * 60 * 24));
                    const ageInHours = Math.floor(ageInMs / (1000 * 60 * 60));
                    
                    if (ageInDays > 0) {
                      return `Created ${ageInDays} day${ageInDays !== 1 ? 's' : ''} ago`;
                    } else if (ageInHours > 0) {
                      return `Created ${ageInHours} hour${ageInHours !== 1 ? 's' : ''} ago`;
                    } else {
                      return 'Created recently';
                    }
                  })()}
                </div>
                
                <div>
                  {(() => {
                    // Rough estimate: ~10MB per minute for restore
                    const sizeInMB = selectedBackup.sizeBytes / (1024 * 1024);
                    const estimatedMinutes = Math.max(1, Math.round(sizeInMB / 10));
                    
                    if (estimatedMinutes < 60) {
                      return `~${estimatedMinutes} min restore`;
                    } else {
                      const hours = Math.floor(estimatedMinutes / 60);
                      const mins = estimatedMinutes % 60;
                      return `~${hours}h ${mins}m restore`;
                    }
                  })()}
                </div>
              </div>
            </div>
          )}
          
          <div className="space-y-4 py-4">
            <div>
              <Label className="text-base font-medium">Restore Destination</Label>
              <RadioGroup
                value={restoreDestination}
                onValueChange={(value) => setRestoreDestination(value as "overwrite" | "new")}
                className="mt-2"
              >
                <div className="flex items-start space-x-2">
                  <RadioGroupItem value="overwrite" id="overwrite" className="mt-0.5" />
                  <div className="space-y-1">
                    <Label htmlFor="overwrite" className="font-medium">
                      Overwrite "{database.name}"
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Replace all data in the existing database.
                      <br />
                      <strong className="text-red-600">This cannot be undone.</strong>
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-2">
                  <RadioGroupItem value="new" id="new" className="mt-0.5" />
                  <div className="space-y-2 flex-1">
                    <Label htmlFor="new" className="font-medium">
                      Restore to new database
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Create a new database with the restored data.
                    </p>
                    {restoreDestination === "new" && (
                      <div className="space-y-1">
                        <Label htmlFor="newDbName" className="text-sm">
                          New Database Name
                        </Label>
                        <Input
                          id="newDbName"
                          value={newDatabaseName}
                          onChange={(e) => setNewDatabaseName(e.target.value)}
                          placeholder="Enter new database name"
                          className="text-sm"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </RadioGroup>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmRestoreOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestoreConfirm}
              disabled={
                createRestoreMutation.isPending ||
                (restoreDestination === "new" && !newDatabaseName.trim())
              }
              className={restoreDestination === "overwrite" ? "bg-red-600 hover:bg-red-700" : ""}
            >
              {createRestoreMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              {createRestoreMutation.isPending
                ? "Starting Restore..."
                : restoreDestination === "overwrite"
                ? "Overwrite Database"
                : "Create & Restore"
              }
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}