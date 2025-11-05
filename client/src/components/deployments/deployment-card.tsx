import React, { useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconPlayerPlay,
  IconEdit,
  IconDotsVertical,
  IconClock,
  IconContainer,
  IconCheck,
  IconX,
  IconLoader2,
  IconTrash,
  IconEye,
} from "@tabler/icons-react";

import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useDeploymentTrigger } from "@/hooks/use-deployment-trigger";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { DeploymentConfigurationInfo, DeploymentInfo, DeploymentStatus, Environment } from "@mini-infra/types";

interface DeploymentCardProps {
  config: DeploymentConfigurationInfo;
  latestDeployment?: DeploymentInfo;
  environment?: Environment;
  onEdit?: (config: DeploymentConfigurationInfo) => void;
  onUninstall?: (config: DeploymentConfigurationInfo) => void;
}

// Status icon component
const DeploymentStatusIcon = React.memo(({ status }: { status: DeploymentStatus }) => {
  const getIcon = () => {
    switch (status) {
      case "completed":
        return <IconCheck className="h-4 w-4 text-green-500" />;
      case "failed":
        return <IconX className="h-4 w-4 text-red-500" />;
      case "pending":
        return <IconClock className="h-4 w-4 text-yellow-500" />;
      case "preparing":
      case "deploying":
      case "health_checking":
      case "switching_traffic":
      case "cleanup":
        return <IconLoader2 className="h-4 w-4 text-blue-500 animate-spin" />;
      case "rolling_back":
        return <IconLoader2 className="h-4 w-4 text-orange-500 animate-spin" />;
      case "uninstalling":
      case "removing_from_lb":
      case "stopping_application":
      case "removing_application":
        return <IconLoader2 className="h-4 w-4 text-purple-500 animate-spin" />;
      case "uninstalled":
        return <IconTrash className="h-4 w-4 text-gray-500" />;
      default:
        return <IconClock className="h-4 w-4 text-gray-500" />;
    }
  };

  return getIcon();
});
DeploymentStatusIcon.displayName = "DeploymentStatusIcon";

// Status badge component
const DeploymentStatusBadge = React.memo(({ status }: { status: DeploymentStatus }) => {
  const getVariantAndColor = () => {
    switch (status) {
      case "completed":
        return { variant: "default" as const, className: "bg-green-500 text-white" };
      case "failed":
        return { variant: "destructive" as const, className: "" };
      case "pending":
        return { variant: "secondary" as const, className: "bg-yellow-500 text-white" };
      case "preparing":
      case "deploying":
      case "health_checking":
      case "switching_traffic":
      case "cleanup":
        return { variant: "default" as const, className: "bg-blue-500 text-white" };
      case "rolling_back":
        return { variant: "default" as const, className: "bg-orange-500 text-white" };
      case "uninstalling":
      case "removing_from_lb":
      case "stopping_application":
      case "removing_application":
        return { variant: "default" as const, className: "bg-purple-500 text-white" };
      case "uninstalled":
        return { variant: "secondary" as const, className: "bg-gray-500 text-white" };
      default:
        return { variant: "outline" as const, className: "" };
    }
  };

  const { variant, className } = getVariantAndColor();
  const displayText = status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());

  return (
    <Badge variant={variant} className={className}>
      {displayText}
    </Badge>
  );
});
DeploymentStatusBadge.displayName = "DeploymentStatusBadge";

export const DeploymentCard = React.memo(function DeploymentCard({
  config,
  latestDeployment,
  environment,
  onEdit,
  onUninstall,
}: DeploymentCardProps) {
  const { formatDateTime, formatDate } = useFormattedDate();
  const triggerMutation = useDeploymentTrigger();
  const navigate = useNavigate();

  const handleTriggerDeployment = useCallback(async () => {
    try {
      await triggerMutation.mutateAsync({ applicationName: config.applicationName });
      toast.success(`Deployment triggered for ${config.applicationName}`);
    } catch (error) {
      toast.error(`Failed to trigger deployment: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }, [config.applicationName, triggerMutation]);

  const handleEdit = useCallback(() => {
    onEdit?.(config);
  }, [config, onEdit]);

  const handleUninstall = useCallback(() => {
    onUninstall?.(config);
  }, [config, onUninstall]);

  const handleViewDetails = useCallback(() => {
    navigate(`/deployments/${config.id}`);
  }, [config.id, navigate]);

  // Calculate deployment statistics
  const deploymentStats = useMemo(() => {
    if (!latestDeployment) {
      return {
        lastDeploy: "Never",
        duration: "N/A",
        success: false,
      };
    }

    return {
      lastDeploy: formatDate(latestDeployment.startedAt),
      duration: latestDeployment.deploymentTime 
        ? `${latestDeployment.deploymentTime}s` 
        : "In progress",
      success: latestDeployment.status === "completed",
    };
  }, [latestDeployment, formatDate]);

  const isDeploymentActive = useMemo(() => {
    if (!latestDeployment) return false;
    const activeStatuses: DeploymentStatus[] = [
      "pending", "preparing", "deploying", "health_checking",
      "switching_traffic", "cleanup", "rolling_back",
      "uninstalling", "removing_from_lb", "stopping_application", "removing_application"
    ];
    return activeStatuses.includes(latestDeployment.status as DeploymentStatus);
  }, [latestDeployment]);

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2">
              <IconContainer className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-lg">{config.applicationName}</h3>
              <Badge variant={config.isActive ? "default" : "secondary"} className="ml-auto">
                {config.isActive ? "Active" : "Inactive"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground font-mono">
              {config.dockerImage}
            </p>
            {environment && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-muted-foreground">Environment:</span>
                <Badge variant={environment.type === 'production' ? 'destructive' : 'secondary'} className="text-xs">
                  {environment.name}
                </Badge>
              </div>
            )}
          </div>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <IconDotsVertical className="h-4 w-4" />
                <span className="sr-only">Open menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleEdit}>
                <IconEdit className="h-4 w-4 mr-2" />
                Edit Configuration
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleUninstall} className="text-destructive">
                Delete Configuration
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Deployment Status Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Latest Deployment</span>
            {latestDeployment ? (
              <div className="flex items-center gap-2">
                <DeploymentStatusIcon status={latestDeployment.status as DeploymentStatus} />
                <DeploymentStatusBadge status={latestDeployment.status as DeploymentStatus} />
              </div>
            ) : (
              <Badge variant="outline">Never deployed</Badge>
            )}
          </div>
          
          {latestDeployment && (
            <div className="text-xs text-muted-foreground space-y-1">
              <div>Started: {formatDateTime(latestDeployment.startedAt)}</div>
              {latestDeployment.completedAt && (
                <div>Completed: {formatDateTime(latestDeployment.completedAt)}</div>
              )}
              {latestDeployment.deploymentTime && (
                <div>Duration: {latestDeployment.deploymentTime}s</div>
              )}
            </div>
          )}
        </div>

        {/* Container Details */}
        {latestDeployment?.containers && latestDeployment.containers.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Deployed Containers</span>
              <Badge variant="secondary" className="text-xs">
                {latestDeployment.containers.length} container{latestDeployment.containers.length !== 1 ? 's' : ''}
              </Badge>
            </div>
            <div className="space-y-1">
              {latestDeployment.containers.slice(0, 2).map((container) => (
                <div key={container.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="px-1.5 py-0.5 text-xs">
                      {container.containerRole}
                    </Badge>
                    <span className="font-mono text-xs truncate max-w-[120px]" title={container.containerName}>
                      {container.containerName}
                    </span>
                  </div>
                  <span className="text-muted-foreground">{container.status}</span>
                </div>
              ))}
              {latestDeployment.containers.length > 2 && (
                <div className="text-xs text-muted-foreground text-center py-1">
                  +{latestDeployment.containers.length - 2} more containers
                </div>
              )}
            </div>
          </div>
        )}

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 pt-2 border-t">
          <div className="text-center">
            <div className="text-sm font-medium">{deploymentStats.lastDeploy}</div>
            <div className="text-xs text-muted-foreground">Last Deploy</div>
          </div>
          <div className="text-center">
            <div className="text-sm font-medium">{deploymentStats.duration}</div>
            <div className="text-xs text-muted-foreground">Duration</div>
          </div>
          <div className="text-center">
            <div className={`text-sm font-medium ${deploymentStats.success ? 'text-green-600' : 'text-red-600'}`}>
              {latestDeployment ? (deploymentStats.success ? 'Success' : 'Failed') : 'N/A'}
            </div>
            <div className="text-xs text-muted-foreground">Status</div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2">
          <Button
            onClick={handleViewDetails}
            variant="outline"
            size="sm"
          >
            <IconEye className="h-4 w-4 mr-2" />
            Details
          </Button>
          <Button
            onClick={handleTriggerDeployment}
            disabled={triggerMutation.isPending || !config.isActive || isDeploymentActive}
            className="flex-1"
            size="sm"
          >
            {triggerMutation.isPending ? (
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <IconPlayerPlay className="h-4 w-4 mr-2" />
            )}
            {isDeploymentActive ? "Deploying..." : "Deploy"}
          </Button>
        </div>
        
        {isDeploymentActive && (
          <div className="text-xs text-blue-600 bg-blue-50 dark:bg-blue-900/20 p-2 rounded">
            <div className="flex items-center gap-2">
              <IconLoader2 className="h-3 w-3 animate-spin" />
              Deployment in progress. Updates will appear in real-time.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});