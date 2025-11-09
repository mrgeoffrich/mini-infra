import { IconCircleCheck, IconCircleX, IconAlertCircle } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface HealthStatusBadgeProps {
  status: "healthy" | "unhealthy" | "unknown";
  size?: "sm" | "md" | "lg";
}

export function HealthStatusBadge({ status, size = "md" }: HealthStatusBadgeProps) {
  const config = {
    healthy: {
      icon: IconCircleCheck,
      label: "Healthy",
      className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    },
    unhealthy: {
      icon: IconCircleX,
      label: "Unhealthy",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
    },
    unknown: {
      icon: IconAlertCircle,
      label: "Unknown",
      className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300"
    }
  };

  const { icon: Icon, label, className } = config[status];

  const sizeClasses = {
    sm: "text-xs px-2 py-0.5",
    md: "text-sm px-2.5 py-1",
    lg: "text-base px-3 py-1.5"
  };

  const iconSizes = {
    sm: "h-3 w-3",
    md: "h-4 w-4",
    lg: "h-5 w-5"
  };

  return (
    <Badge className={cn("inline-flex items-center gap-1.5", className, sizeClasses[size])}>
      <Icon className={iconSizes[size]} />
      {label}
    </Badge>
  );
}
