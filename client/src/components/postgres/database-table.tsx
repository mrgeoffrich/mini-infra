import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { IconCalendar, IconDownload, IconPencil, IconTrash, IconPlayerPlay } from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useCreateManualBackup } from "@/hooks/use-postgres-backup-operations";
import { usePostgresBackupConfig } from "@/hooks/use-postgres-backup-configs";
import { HealthStatusBadge, BackupStatusDisplay } from "./status-badges";
import { toast } from "sonner";
import type { PostgresDatabaseInfo } from "@mini-infra/types";

interface DatabaseTableProps {
  databases: PostgresDatabaseInfo[];
  onEditDatabase: (database: PostgresDatabaseInfo) => void;
  onDeleteDatabase: (database: PostgresDatabaseInfo) => void;
  onConfigureBackup: (database: PostgresDatabaseInfo) => void;
  onBrowseBackups: (database: PostgresDatabaseInfo) => void;
}

export function DatabaseTable({
  databases,
  onEditDatabase,
  onDeleteDatabase,
  onConfigureBackup,
  onBrowseBackups,
}: DatabaseTableProps) {
  const manualBackupMutation = useCreateManualBackup();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Host</TableHead>
          <TableHead>Database</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Backup Status</TableHead>
          <TableHead>Next Backup</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {databases.map((database) => (
          <TableRow key={database.id}>
            <TableCell className="font-medium">{database.name}</TableCell>
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
              <NextBackupCell databaseId={database.id} />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-2">
                <ManualBackupButton
                  database={database}
                  manualBackupMutation={manualBackupMutation}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onConfigureBackup(database)}
                  title="Configure Backup"
                >
                  <IconCalendar className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onBrowseBackups(database)}
                  title="Browse Backups & Restore"
                >
                  <IconDownload className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditDatabase(database)}
                  title="Edit Database"
                >
                  <IconPencil className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onDeleteDatabase(database)}
                  title="Delete Database"
                >
                  <IconTrash className="w-4 h-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Component to display next backup time
function NextBackupCell({ databaseId }: { databaseId: string }) {
  const { formatDateTime } = useFormattedDate();
  const { data: backupConfigResponse } = usePostgresBackupConfig(databaseId);

  const backupConfig = backupConfigResponse?.data;

  if (
    !backupConfig ||
    !backupConfig.isEnabled ||
    !backupConfig.nextScheduledAt
  ) {
    return <span className="text-muted-foreground">Not scheduled</span>;
  }

  return formatDateTime(backupConfig.nextScheduledAt);
}

// Component for manual backup button
function ManualBackupButton({
  database,
  manualBackupMutation,
}: {
  database: PostgresDatabaseInfo;
  manualBackupMutation: ReturnType<typeof useCreateManualBackup>;
}) {
  const { data: backupConfigResponse } = usePostgresBackupConfig(database.id);
  const backupConfig = backupConfigResponse?.data;

  const handleManualBackup = async () => {
    try {
      await manualBackupMutation.mutateAsync(database.id);
      toast.success("Manual backup started successfully");
    } catch {
      toast.error("Failed to start manual backup");
    }
  };

  // Only show button if backup is configured
  if (!backupConfig) {
    return null;
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleManualBackup}
      disabled={manualBackupMutation.isPending}
      title="Start Manual Backup"
    >
      <IconPlayerPlay className="w-4 h-4" />
    </Button>
  );
}
