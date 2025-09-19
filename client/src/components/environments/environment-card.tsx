import { useState } from "react";
import { Environment, EnvironmentType } from "@mini-infra/types";

const ApplicationServiceHealthStatusValues = {
  HEALTHY: 'healthy' as const,
  UNHEALTHY: 'unhealthy' as const,
  UNKNOWN: 'unknown' as const,
};
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useStartEnvironment, useStopEnvironment } from "@/hooks/use-environments";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnvironmentStatus, ServiceHealth } from "./environment-status";
import { cn } from "@/lib/utils";
import {
  MoreHorizontal,
  Play,
  Square,
  Settings,
  Trash2,
  Network,
  HardDrive,
  Server,
  Users,
} from "lucide-react";
import { toast } from "sonner";

interface EnvironmentCardProps {
  environment: Environment;
  onEdit?: (environment: Environment) => void;
  onDelete?: (environment: Environment) => void;
  onAddService?: (environment: Environment) => void;
  onSelect?: (environment: Environment) => void;
  isSelected?: boolean;
  className?: string;
}

export function EnvironmentCard({
  environment,
  onEdit,
  onDelete,
  onAddService,
  onSelect,
  isSelected = false,
  className,
}: EnvironmentCardProps) {
  const { formatDateTime } = useFormattedDate();
  const [isOperating, setIsOperating] = useState(false);

  const startMutation = useStartEnvironment();
  const stopMutation = useStopEnvironment();

  const isRunning = environment.status === "running";
  const canStart = environment.status === "stopped" || environment.status === "failed";
  const canStop = environment.status === "running" || environment.status === "degraded";

  const handleStart = async () => {
    setIsOperating(true);
    try {
      await startMutation.mutateAsync(environment.id);
      toast.success(`Environment "${environment.name}" started successfully`);
    } catch (error) {
      toast.error(
        `Failed to start environment: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsOperating(false);
    }
  };

  const handleStop = async () => {
    setIsOperating(true);
    try {
      await stopMutation.mutateAsync(environment.id);
      toast.success(`Environment "${environment.name}" stopped successfully`);
    } catch (error) {
      toast.error(
        `Failed to stop environment: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsOperating(false);
    }
  };

  const getTypeColor = (type: EnvironmentType) => {
    return type === "production"
      ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      : "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
  };

  const healthyServices = environment.services.filter(
    (service) => service.health === ApplicationServiceHealthStatusValues.HEALTHY,
  ).length;
  const totalServices = environment.services.length;

  return (
    <Card
      className={cn(
        "transition-all hover:shadow-md cursor-pointer",
        isSelected && "ring-2 ring-primary bg-accent/50",
        className
      )}
      onClick={() => onSelect?.(environment)}
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg font-semibold">
              {environment.name}
            </CardTitle>
            <Badge
              variant="outline"
              className={cn("text-xs", getTypeColor(environment.type))}
            >
              {environment.type}
            </Badge>
          </div>
          {environment.description && (
            <CardDescription className="text-sm">
              {environment.description}
            </CardDescription>
          )}
        </div>
        <div className="flex items-center gap-2">
          <EnvironmentStatus status={environment.status} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Open menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canStart && (
                <DropdownMenuItem
                  onClick={handleStart}
                  disabled={isOperating}
                  className="flex items-center gap-2"
                >
                  <Play className="h-4 w-4" />
                  Start Environment
                </DropdownMenuItem>
              )}
              {canStop && (
                <DropdownMenuItem
                  onClick={handleStop}
                  disabled={isOperating}
                  className="flex items-center gap-2"
                >
                  <Square className="h-4 w-4" />
                  Stop Environment
                </DropdownMenuItem>
              )}
              {(canStart || canStop) && <DropdownMenuSeparator />}
              {onAddService && (
                <DropdownMenuItem
                  onClick={() => onAddService(environment)}
                  className="flex items-center gap-2"
                >
                  <Server className="h-4 w-4" />
                  Add Service
                </DropdownMenuItem>
              )}
              {onEdit && (
                <DropdownMenuItem
                  onClick={() => onEdit(environment)}
                  className="flex items-center gap-2"
                >
                  <Settings className="h-4 w-4" />
                  Edit Environment
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDelete(environment)}
                    className="flex items-center gap-2 text-red-600 focus:text-red-600"
                    disabled={isRunning}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete Environment
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Services Summary */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            <span>Services</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {healthyServices}/{totalServices}
            </span>
            {totalServices > 0 && (
              <div className="flex items-center gap-1">
                {healthyServices === totalServices ? (
                  <ServiceHealth health={ApplicationServiceHealthStatusValues.HEALTHY} />
                ) : healthyServices > 0 ? (
                  <ServiceHealth health={ApplicationServiceHealthStatusValues.UNKNOWN} />
                ) : (
                  <ServiceHealth health={ApplicationServiceHealthStatusValues.UNHEALTHY} />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Networks and Volumes */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Network className="h-4 w-4" />
            <span>{environment.networks.length} Networks</span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <HardDrive className="h-4 w-4" />
            <span>{environment.volumes.length} Volumes</span>
          </div>
        </div>

        {/* Services List */}
        {environment.services.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Services</div>
            <div className="grid grid-cols-1 gap-2">
              {environment.services.slice(0, 3).map((service) => (
                <div
                  key={service.id}
                  className="flex items-center justify-between rounded-md border p-2"
                >
                  <div className="flex items-center gap-2">
                    <Server className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {service.serviceName}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {service.serviceType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <EnvironmentStatus status={service.status} />
                    <ServiceHealth health={service.health} />
                  </div>
                </div>
              ))}
              {environment.services.length > 3 && (
                <div className="text-sm text-muted-foreground text-center py-1">
                  +{environment.services.length - 3} more services
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground">
          <span>Created {formatDateTime(environment.createdAt)}</span>
          {environment.isActive && (
            <Badge variant="outline" className="text-xs">
              Active
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}