import type { ServiceStatus, ApplicationServiceHealthStatus } from "@mini-infra/types";

// Import the values directly as constants to avoid enum issues
const ServiceStatusValues = {
  UNINITIALIZED: 'uninitialized' as const,
  INITIALIZING: 'initializing' as const,
  INITIALIZED: 'initialized' as const,
  STARTING: 'starting' as const,
  RUNNING: 'running' as const,
  STOPPING: 'stopping' as const,
  STOPPED: 'stopped' as const,
  FAILED: 'failed' as const,
  DEGRADED: 'degraded' as const,
};

const ApplicationServiceHealthStatusValues = {
  HEALTHY: 'healthy' as const,
  UNHEALTHY: 'unhealthy' as const,
  UNKNOWN: 'unknown' as const,
};
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconAlertTriangle,
  IconCircleDot,
  IconLoader2,
  IconServer,
  IconPlayerPause,
} from "@tabler/icons-react";

interface EnvironmentStatusProps {
  status: ServiceStatus;
  className?: string;
}

interface ServiceHealthProps {
  health: ApplicationServiceHealthStatus;
  className?: string;
}

export function EnvironmentStatus({ status, className }: EnvironmentStatusProps) {
  const getStatusConfig = (status: ServiceStatus) => {
    switch (status) {
      case ServiceStatusValues.RUNNING:
        return {
          icon: IconCircleCheck,
          text: "Running",
          variant: "default" as const,
          className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
        };
      case ServiceStatusValues.STOPPED:
        return {
          icon: IconPlayerPause,
          text: "Stopped",
          variant: "secondary" as const,
          className: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
        };
      case ServiceStatusValues.STARTING:
        return {
          icon: IconLoader2,
          text: "Starting",
          variant: "outline" as const,
          className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
        };
      case ServiceStatusValues.STOPPING:
        return {
          icon: IconLoader2,
          text: "Stopping",
          variant: "outline" as const,
          className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
        };
      case ServiceStatusValues.FAILED:
        return {
          icon: IconCircleX,
          text: "Failed",
          variant: "destructive" as const,
          className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
        };
      case ServiceStatusValues.DEGRADED:
        return {
          icon: IconAlertTriangle,
          text: "Degraded",
          variant: "outline" as const,
          className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
        };
      case ServiceStatusValues.INITIALIZING:
        return {
          icon: IconClock,
          text: "Initializing",
          variant: "outline" as const,
          className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
        };
      case ServiceStatusValues.INITIALIZED:
        return {
          icon: IconCircleDot,
          text: "Initialized",
          variant: "outline" as const,
          className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300",
        };
      case ServiceStatusValues.UNINITIALIZED:
      default:
        return {
          icon: IconServer,
          text: "Uninitialized",
          variant: "outline" as const,
          className: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
        };
    }
  };

  const config = getStatusConfig(status);
  const Icon = config.icon;

  return (
    <Badge
      variant={config.variant}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1",
        config.className,
        className,
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5",
          (status === ServiceStatusValues.STARTING || status === ServiceStatusValues.STOPPING) &&
            "animate-spin",
        )}
      />
      <span className="text-xs font-medium">{config.text}</span>
    </Badge>
  );
}

export function ServiceHealth({ health, className }: ServiceHealthProps) {
  const getHealthConfig = (health: ApplicationServiceHealthStatus) => {
    switch (health) {
      case ApplicationServiceHealthStatusValues.HEALTHY:
        return {
          icon: IconCircleCheck,
          text: "Healthy",
          className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
        };
      case ApplicationServiceHealthStatusValues.UNHEALTHY:
        return {
          icon: IconCircleX,
          text: "Unhealthy",
          className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
        };
      case ApplicationServiceHealthStatusValues.UNKNOWN:
      default:
        return {
          icon: IconAlertTriangle,
          text: "Unknown",
          className: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
        };
    }
  };

  const config = getHealthConfig(health);
  const Icon = config.icon;

  return (
    <Badge
      variant="outline"
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1",
        config.className,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="text-xs font-medium">{config.text}</span>
    </Badge>
  );
}