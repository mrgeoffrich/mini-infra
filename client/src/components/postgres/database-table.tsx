import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Calendar,
  Download,
  Pencil,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { HealthStatusBadge, BackupStatusDisplay } from "./status-badges";
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
  return (
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
                    "MMM d, yyyy HH:mm"
                  )
                : "Never"}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onConfigureBackup(database)}
                  title="Configure Backup"
                >
                  <Calendar className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onBrowseBackups(database)}
                  title="Browse Backups & Restore"
                >
                  <Download className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditDatabase(database)}
                  title="Edit Database"
                >
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onDeleteDatabase(database)}
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
  );
}