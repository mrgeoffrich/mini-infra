import { Badge } from "@/components/ui/badge";
import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconLoader2,
  IconAlertCircle,
  IconPlayerPlay,
} from "@tabler/icons-react";
import type {
  BackupOperationStatus,
  RestoreOperationStatus,
} from "@mini-infra/types";

type OperationStatus = BackupOperationStatus | RestoreOperationStatus;

interface OperationStatusBadgeProps {
  status: OperationStatus;
  showIcon?: boolean;
  variant?: "default" | "compact";
  className?: string;
}

export function OperationStatusBadge({
  status,
  showIcon = true,
  variant = "default",
  className,
}: OperationStatusBadgeProps) {
  const getStatusConfig = (status: OperationStatus) => {
    switch (status) {
      case "completed":
        return {
          label: "Completed",
          icon: IconCircleCheck,
          className: "text-green-700 border-green-200 bg-green-50",
        };
      case "failed":
        return {
          label: "Failed",
          icon: IconCircleX,
          className: "text-red-700 border-red-200 bg-red-50",
        };
      case "running":
        return {
          label: "Running",
          icon: IconLoader2,
          className: "text-blue-700 border-blue-200 bg-blue-50",
          animate: true,
        };
      case "pending":
        return {
          label: "Pending",
          icon: IconClock,
          className: "text-yellow-700 border-yellow-200 bg-yellow-50",
        };
      default:
        return {
          label: "Unknown",
          icon: IconAlertCircle,
          className: "text-gray-700 border-gray-200 bg-gray-50",
        };
    }
  };

  const config = getStatusConfig(status);
  const Icon = config.icon;
  const isCompact = variant === "compact";

  return (
    <Badge
      variant="outline"
      className={`${config.className} ${className || ""} ${
        isCompact ? "text-xs px-2 py-0.5" : ""
      }`}
    >
      {showIcon && (
        <Icon
          className={`${isCompact ? "w-2.5 h-2.5" : "w-3 h-3"} ${
            isCompact ? "mr-1" : "mr-1"
          } ${config.animate ? "animate-spin" : ""}`}
        />
      )}
      {config.label}
    </Badge>
  );
}

interface OperationTypeBadgeProps {
  type: "backup" | "restore";
  operationType?: string;
  showIcon?: boolean;
  variant?: "default" | "compact";
  className?: string;
}

export function OperationTypeBadge({
  type,
  operationType,
  showIcon = true,
  variant = "default",
  className,
}: OperationTypeBadgeProps) {
  const getTypeConfig = (
    type: "backup" | "restore",
    operationType?: string,
  ) => {
    if (type === "backup") {
      const isManual = operationType === "manual";
      return {
        label: isManual ? "Manual Backup" : "Scheduled Backup",
        icon: isManual ? IconPlayerPlay : IconClock,
        className: isManual
          ? "text-purple-700 border-purple-200 bg-purple-50"
          : "text-blue-700 border-blue-200 bg-blue-50",
      };
    } else {
      return {
        label: "Restore",
        icon: IconPlayerPlay,
        className: "text-orange-700 border-orange-200 bg-orange-50",
      };
    }
  };

  const config = getTypeConfig(type, operationType);
  const Icon = config.icon;
  const isCompact = variant === "compact";

  return (
    <Badge
      variant="outline"
      className={`${config.className} ${className || ""} ${
        isCompact ? "text-xs px-2 py-0.5" : ""
      }`}
    >
      {showIcon && (
        <Icon
          className={`${isCompact ? "w-2.5 h-2.5" : "w-3 h-3"} ${
            isCompact ? "mr-1" : "mr-1"
          }`}
        />
      )}
      {config.label}
    </Badge>
  );
}

interface ProgressBadgeProps {
  progress: number;
  showText?: boolean;
  variant?: "default" | "compact";
  className?: string;
}

export function ProgressBadge({
  progress,
  showText = true,
  variant = "default",
  className,
}: ProgressBadgeProps) {
  const getProgressColor = (progress: number) => {
    if (progress >= 100) return "text-green-700 border-green-200 bg-green-50";
    if (progress >= 75) return "text-blue-700 border-blue-200 bg-blue-50";
    if (progress >= 50) return "text-yellow-700 border-yellow-200 bg-yellow-50";
    if (progress >= 25) return "text-orange-700 border-orange-200 bg-orange-50";
    return "text-gray-700 border-gray-200 bg-gray-50";
  };

  const isCompact = variant === "compact";
  const colorClass = getProgressColor(progress);

  return (
    <Badge
      variant="outline"
      className={`${colorClass} ${className || ""} ${
        isCompact ? "text-xs px-2 py-0.5" : ""
      }`}
    >
      {showText && `${Math.round(progress)}%`}
    </Badge>
  );
}
