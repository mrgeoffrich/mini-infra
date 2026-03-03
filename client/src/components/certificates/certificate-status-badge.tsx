import {
  IconCircleCheck,
  IconClock,
  IconAlertCircle,
  IconCircleX,
  IconBan,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface CertificateStatusBadgeProps {
  status: string;
}

export function CertificateStatusBadge({
  status,
}: CertificateStatusBadgeProps) {
  const statusConfig = {
    ACTIVE: {
      variant: "default" as const,
      icon: IconCircleCheck,
      label: "Active",
      className:
        "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
    },
    PENDING: {
      variant: "secondary" as const,
      icon: IconClock,
      label: "Pending",
      className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
    },
    RENEWING: {
      variant: "secondary" as const,
      icon: IconClock,
      label: "Renewing",
      className:
        "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
    },
    EXPIRED: {
      variant: "destructive" as const,
      icon: IconCircleX,
      label: "Expired",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    },
    REVOKED: {
      variant: "destructive" as const,
      icon: IconBan,
      label: "Revoked",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    },
    ERROR: {
      variant: "destructive" as const,
      icon: IconAlertCircle,
      label: "Error",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    },
  };

  const config =
    statusConfig[status as keyof typeof statusConfig] || statusConfig.ERROR;
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className={cn(config.className)}>
      <Icon className="h-3 w-3 mr-1" />
      {config.label}
    </Badge>
  );
}
