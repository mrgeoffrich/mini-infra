import { Badge } from "@/components/ui/badge";
import {
  IconRocket,
  IconRotateClockwise,
  IconTrash,
  IconServer,
  IconCertificate,
  IconDatabase,
  IconUser,
  IconTools,
  IconSquare,
} from "@tabler/icons-react";
import { UserEventType, UserEventCategory } from "@mini-infra/types";

interface EventTypeBadgeProps {
  eventType: string;
  eventCategory?: string;
  className?: string;
  showIcon?: boolean;
}

export function EventTypeBadge({
  eventType,
  className,
  showIcon = true,
}: EventTypeBadgeProps) {
  const getTypeConfig = (type: string) => {
    switch (type as UserEventType) {
      case "deployment":
        return {
          label: "Deployment",
          icon: IconRocket,
          className: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
        };
      case "deployment_rollback":
        return {
          label: "Rollback",
          icon: IconRotateClockwise,
          className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
        };
      case "deployment_uninstall":
        return {
          label: "Uninstall",
          icon: IconTrash,
          className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
        };
      case "environment_start":
      case "environment_stop":
      case "environment_create":
      case "environment_delete":
        return {
          label: type.replace("environment_", "Env ").replace("_", " "),
          icon: IconServer,
          className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
        };
      case "certificate_create":
      case "certificate_renew":
      case "certificate_revoke":
        return {
          label: type.replace("certificate_", "Cert ").replace("_", " "),
          icon: IconCertificate,
          className: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300",
        };
      case "backup":
      case "backup_cleanup":
      case "restore":
      case "database_create":
      case "database_delete":
        return {
          label: type.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase()),
          icon: IconDatabase,
          className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
        };
      case "user_create":
      case "user_delete":
        return {
          label: type.replace("user_", "User ").replace("_", " "),
          icon: IconUser,
          className: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300",
        };
      case "container_cleanup":
        return {
          label: "Container Cleanup",
          icon: IconTrash,
          className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
        };
      case "system_maintenance":
        return {
          label: "Maintenance",
          icon: IconTools,
          className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
      default:
        return {
          label: type.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase()),
          icon: IconSquare,
          className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
    }
  };

  const config = getTypeConfig(eventType);
  const Icon = config.icon;

  return (
    <Badge className={`${config.className} ${className || ""} flex items-center gap-1`} variant="outline">
      {showIcon && <Icon className="h-3 w-3" />}
      {config.label}
    </Badge>
  );
}

interface EventCategoryBadgeProps {
  category: string;
  className?: string;
}

export function EventCategoryBadge({ category, className }: EventCategoryBadgeProps) {
  const getCategoryConfig = (cat: string) => {
    switch (cat as UserEventCategory) {
      case "infrastructure":
        return {
          label: "Infrastructure",
          className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
        };
      case "database":
        return {
          label: "Database",
          className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
        };
      case "security":
        return {
          label: "Security",
          className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
        };
      case "maintenance":
        return {
          label: "Maintenance",
          className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
      case "configuration":
        return {
          label: "Configuration",
          className: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
        };
      default:
        return {
          label: cat.replace(/\b\w/g, (l) => l.toUpperCase()),
          className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
    }
  };

  const config = getCategoryConfig(category);

  return (
    <Badge className={`${config.className} ${className || ""}`} variant="outline">
      {config.label}
    </Badge>
  );
}
