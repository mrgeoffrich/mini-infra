import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
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
  useAvailableBackups,
  useCreateRestoreOperation,
  usePostgresRestoreOperations,
  useBackupBrowserFilters,
  usePostgresRestoreOperationFilters,
} from "@/hooks/use-postgres-restore-operations";
import { usePostgresBackupConfig } from "@/hooks/use-postgres-backup-configs";
import {
  Database,
  AlertCircle,
  Loader2,
  RefreshCw,
  Search,
  History,
  Undo,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { RestoreOperationStatusBadge } from "./status-badges";
import type {
  PostgresDatabaseInfo,
  BackupBrowserItem,
  CreateRestoreOperationRequest,
} from "@mini-infra/types";

interface RestoreBrowserModalProps {
  database: PostgresDatabaseInfo;
  isOpen: boolean;
  onClose: () => void;
}

export function RestoreBrowserModal({
  database,
  isOpen,
  onClose,
}: RestoreBrowserModalProps) {
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
        }`
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
                            "MMM d, yyyy HH:mm"
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
                                  1000
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