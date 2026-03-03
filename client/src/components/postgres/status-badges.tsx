import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconCircleCheck,
  IconCircleX,
  IconAlertCircle,
  IconClock,
  IconCalendar,
  IconLoader2,
} from "@tabler/icons-react";
import { usePostgresBackupConfig } from "@/hooks/use-postgres-backup-configs";
import type {
  DatabaseHealthStatus,
  PostgresDatabaseInfo,
  RestoreOperationStatus,
} from "@mini-infra/types";

export function HealthStatusBadge({
  status,
}: {
  status: DatabaseHealthStatus;
}) {
  switch (status) {
    case "healthy":
      return (
        <Badge variant="outline" className="text-green-700 border-green-200">
          <IconCircleCheck className="w-3 h-3 mr-1" />
          Healthy
        </Badge>
      );
    case "unhealthy":
      return (
        <Badge variant="outline" className="text-red-700 border-red-200">
          <IconCircleX className="w-3 h-3 mr-1" />
          Unhealthy
        </Badge>
      );
    case "unknown":
    default:
      return (
        <Badge variant="outline" className="text-gray-700 border-gray-200">
          <IconAlertCircle className="w-3 h-3 mr-1" />
          Unknown
        </Badge>
      );
  }
}

export function BackupStatusDisplay({
  database,
}: {
  database: PostgresDatabaseInfo;
}) {
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
        <IconAlertCircle className="w-3 h-3 mr-1" />
        Not Configured
      </Badge>
    );
  }

  if (!backupConfig.isEnabled) {
    return (
      <Badge variant="outline" className="text-yellow-700 border-yellow-200">
        <IconClock className="w-3 h-3 mr-1" />
        Disabled
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-green-700 border-green-200">
      <IconCalendar className="w-3 h-3 mr-1" />
      Scheduled
    </Badge>
  );
}

export function RestoreOperationStatusBadge({
  status,
}: {
  status: RestoreOperationStatus;
}) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="outline" className="text-green-700 border-green-200">
          <IconCircleCheck className="w-3 h-3 mr-1" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="text-red-700 border-red-200">
          <IconCircleX className="w-3 h-3 mr-1" />
          Failed
        </Badge>
      );
    case "running":
      return (
        <Badge variant="outline" className="text-blue-700 border-blue-200">
          <IconLoader2 className="w-3 h-3 mr-1 animate-spin" />
          Running
        </Badge>
      );
    case "pending":
    default:
      return (
        <Badge variant="outline" className="text-yellow-700 border-yellow-200">
          <IconClock className="w-3 h-3 mr-1" />
          Pending
        </Badge>
      );
  }
}
