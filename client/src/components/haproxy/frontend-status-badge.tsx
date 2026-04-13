import { Badge } from "@/components/ui/badge";
import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconAlertCircle,
  IconTrash,
} from "@tabler/icons-react";
import type { HAProxyFrontendInfo } from "@mini-infra/types";

type FrontendStatus = HAProxyFrontendInfo["status"];

interface FrontendStatusBadgeProps {
  status: FrontendStatus;
  showIcon?: boolean;
  variant?: "default" | "compact";
  className?: string;
}

export function FrontendStatusBadge({
  status,
  showIcon = true,
  variant = "default",
  className,
}: FrontendStatusBadgeProps) {
  const getStatusConfig = (status: FrontendStatus) => {
    switch (status) {
      case "active":
        return {
          label: "Active",
          icon: IconCircleCheck,
          className: "text-green-700 border-green-200 bg-green-50",
        };
      case "pending":
        return {
          label: "Pending",
          icon: IconClock,
          className: "text-yellow-700 border-yellow-200 bg-yellow-50",
        };
      case "failed":
        return {
          label: "Failed",
          icon: IconCircleX,
          className: "text-red-700 border-red-200 bg-red-50",
        };
      case "removed":
        return {
          label: "Removed",
          icon: IconTrash,
          className: "text-gray-700 border-gray-200 bg-gray-50",
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
          }`}
        />
      )}
      {config.label}
    </Badge>
  );
}
