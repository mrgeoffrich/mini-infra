import { Badge } from "@/components/ui/badge";
import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconLoader,
  IconX,
} from "@tabler/icons-react";
import { UserEventStatus } from "@mini-infra/types";

interface EventStatusBadgeProps {
  status: string;
  className?: string;
}

export function EventStatusBadge({ status, className }: EventStatusBadgeProps) {
  const getStatusConfig = (status: string) => {
    switch (status as UserEventStatus) {
      case "completed":
        return {
          label: "Completed",
          icon: IconCircleCheck,
          className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
        };
      case "failed":
        return {
          label: "Failed",
          icon: IconCircleX,
          className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
        };
      case "running":
        return {
          label: "Running",
          icon: IconLoader,
          className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
        };
      case "pending":
        return {
          label: "Pending",
          icon: IconClock,
          className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
        };
      case "cancelled":
        return {
          label: "Cancelled",
          icon: IconX,
          className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
      default:
        return {
          label: status,
          icon: IconClock,
          className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
    }
  };

  const config = getStatusConfig(status);
  const Icon = config.icon;

  return (
    <Badge className={`${config.className} ${className || ""} flex items-center gap-1`} variant="outline">
      <Icon className={`h-3 w-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}
