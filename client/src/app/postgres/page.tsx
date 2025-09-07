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
import { Database, AlertCircle, Plus } from "lucide-react";
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
      <div className="container mx-auto px-6 py-8">
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

        {/* Progress Indicators for Active Operations and History */}
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
