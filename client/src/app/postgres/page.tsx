import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  usePostgresDatabases,
  usePostgresDatabaseFilters,
} from "@/hooks/use-postgres-databases";
import { usePostgresBackupConfig } from "@/hooks/use-postgres-backup-configs";
import { usePostgresSettings } from "@/hooks/use-postgres-settings";
import { IconDatabase, IconAlertCircle, IconPlus, IconSettings } from "@tabler/icons-react";
import { ProgressIndicators } from "@/components/postgres/progress-indicators";
import { DatabaseModal } from "@/components/postgres/database-modal";
import { BackupConfigurationModal } from "@/components/postgres/backup-configuration-modal";
import { DatabaseTable } from "@/components/postgres/database-table";
import { DeleteDatabaseDialog } from "@/components/postgres/delete-database-dialog";
import type { PostgresDatabaseInfo } from "@mini-infra/types";

export default function PostgresPage() {
  const navigate = useNavigate();
  const [selectedDatabase, setSelectedDatabase] =
    useState<PostgresDatabaseInfo | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [databaseToDelete, setDatabaseToDelete] =
    useState<PostgresDatabaseInfo | null>(null);
  const [backupConfigModalOpen, setBackupConfigModalOpen] = useState(false);
  const [selectedBackupDatabase, setSelectedBackupDatabase] =
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

  const { data: postgresSettings } = usePostgresSettings();

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

  const navigateToRestorePage = (database: PostgresDatabaseInfo) => {
    navigate(`/postgres/${database.id}/restore`);
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

  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconDatabase className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">PostgreSQL Management</h1>
              <p className="text-muted-foreground">
                Configure and manage PostgreSQL database connections
              </p>
            </div>
          </div>

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load PostgreSQL databases: {error.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconDatabase className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">PostgreSQL Management</h1>
              <p className="text-muted-foreground">
                Configure and manage PostgreSQL database connections
              </p>
            </div>
          </div>

          <Button onClick={openCreateModal}>
            <IconPlus className="h-4 w-4 mr-2" />
            Add Database
          </Button>
        </div>

        {/* PostgreSQL Settings Warning */}
        {postgresSettings && !postgresSettings.isConfigured && (
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <div>
                <strong>PostgreSQL containers not configured:</strong> Backup and restore operations require Docker images to be configured in system settings. Configure backup and restore Docker images before using PostgreSQL features.
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/settings/system")}
                className="ml-4 flex-shrink-0"
              >
                <IconSettings className="w-4 h-4 mr-2" />
                Configure Settings
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Database Connections */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <IconDatabase className="w-5 h-5 mr-2" />
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
                <IconDatabase className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-semibold mb-2">
                  No databases configured
                </h3>
                <p className="text-muted-foreground mb-4">
                  Get started by adding your first PostgreSQL database
                  connection
                </p>
                <Button onClick={openCreateModal}>
                  <IconPlus className="w-4 h-4 mr-2" />
                  Add Database
                </Button>
              </div>
            ) : (
              <DatabaseTable
                databases={databases}
                onEditDatabase={openEditModal}
                onDeleteDatabase={openDeleteDialog}
                onConfigureBackup={openBackupConfigModal}
                onBrowseBackups={navigateToRestorePage}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Progress Indicators for Active Operations and History */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <ProgressIndicators showDatabaseSelector={true} defaultTab="active" />
      </div>

      <DatabaseModal
        database={selectedDatabase || undefined}
        isOpen={isModalOpen}
        onClose={closeModal}
      />

      <DeleteDatabaseDialog
        database={databaseToDelete}
        isOpen={isDeleteDialogOpen}
        onClose={closeDeleteDialog}
      />

      {selectedBackupDatabase && (
        <BackupConfigurationModal
          database={selectedBackupDatabase}
          backupConfig={selectedBackupConfig}
          isOpen={backupConfigModalOpen}
          onClose={closeBackupConfigModal}
        />
      )}
    </div>
  );
}
