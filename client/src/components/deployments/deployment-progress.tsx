import React, { useMemo, useCallback } from "react";
import {
  IconPlayerPlay,
  IconCheck,
  IconX,
  IconClock,
  IconRotateClockwise,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";

import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useDeploymentStatus } from "@/hooks/use-deployment-status";
import { useDeploymentRollback } from "@/hooks/use-deployment-rollback";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  DeploymentStatus,
  DeploymentStepInfo,
  DeploymentStepStatus,
} from "@mini-infra/types";

interface DeploymentProgressProps {
  deploymentId: string;
  className?: string;
}

// Step status icon component
const StepStatusIcon = React.memo(({ status }: { status: DeploymentStepStatus }) => {
  const iconMap = {
    pending: IconClock,
    running: IconPlayerPlay,
    completed: IconCheck,
    failed: IconX,
  };

  const colorMap = {
    pending: "text-muted-foreground",
    running: "text-blue-500",
    completed: "text-green-500",
    failed: "text-red-500",
  };

  const Icon = iconMap[status];
  const colorClass = colorMap[status];

  return <Icon className={`h-4 w-4 ${colorClass}`} />;
});
StepStatusIcon.displayName = "StepStatusIcon";

// Step component with timing information
const DeploymentStep = React.memo(({
  step,
}: {
  step: DeploymentStepInfo;
}) => {
  const { formatTime } = useFormattedDate();
  const [isExpanded, setIsExpanded] = React.useState(false);

  const duration = useMemo(() => {
    if (step.duration) {
      if (step.duration < 1000) {
        return `${step.duration}ms`;
      } else if (step.duration < 60000) {
        return `${(step.duration / 1000).toFixed(1)}s`;
      } else {
        return `${(step.duration / 60000).toFixed(1)}min`;
      }
    }
    return null;
  }, [step.duration]);

  const stepName = useMemo(() => {
    const nameMap: Record<string, string> = {
      pull_image: "Pull Docker Image",
      create_container: "Create Container",
      start_container: "Start Container",
      health_check: "Health Check",
      switch_traffic: "Switch Traffic",
      cleanup_old: "Cleanup Old Container",
      rollback: "Rollback Deployment",
    };
    return nameMap[step.stepName] || step.stepName.replace(/_/g, " ");
  }, [step.stepName]);

  const hasOutput = step.output || step.errorMessage;

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-muted bg-background mt-1">
        <StepStatusIcon status={step.status} />
      </div>
      
      <div className="flex-1 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-medium">{stepName}</span>
            {step.status === "running" && (
              <Badge variant="outline" className="animate-pulse">
                In Progress
              </Badge>
            )}
            {step.status === "completed" && duration && (
              <Badge variant="secondary">{duration}</Badge>
            )}
            {step.status === "failed" && (
              <Badge variant="destructive">Failed</Badge>
            )}
          </div>
          
          <div className="text-xs text-muted-foreground">
            {step.status === "running" 
              ? `Started ${formatTime(step.startedAt)}`
              : step.completedAt
              ? `${formatTime(step.startedAt)} - ${formatTime(step.completedAt)}`
              : `Started ${formatTime(step.startedAt)}`
            }
          </div>
        </div>

        {step.status === "failed" && step.errorMessage && (
          <div className="text-sm text-red-600 bg-red-50 p-2 rounded border">
            <div className="flex items-start gap-2">
              <IconAlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{step.errorMessage}</span>
            </div>
          </div>
        )}

        {hasOutput && (
          <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="p-1 h-auto text-xs">
                {isExpanded ? (
                  <IconChevronUp className="h-3 w-3 mr-1" />
                ) : (
                  <IconChevronDown className="h-3 w-3 mr-1" />
                )}
                {isExpanded ? "Hide Details" : "Show Details"}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2">
                <div className="h-24 w-full rounded border bg-muted/50 overflow-y-auto">
                  <div className="p-3">
                    <pre className="text-xs font-mono whitespace-pre-wrap">
                      {step.output || step.errorMessage}
                    </pre>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
});
DeploymentStep.displayName = "DeploymentStep";

// Overall progress bar component
const OverallProgress = React.memo(({
  status,
  progress,
  steps,
}: {
  status: DeploymentStatus;
  progress: number;
  steps: DeploymentStepInfo[];
}) => {
  const statusText = useMemo(() => {
    const statusMap: Record<DeploymentStatus, string> = {
      pending: "Pending",
      preparing: "Preparing Deployment",
      deploying: "Deploying Application",
      health_checking: "Running Health Checks",
      switching_traffic: "Switching Traffic",
      cleanup: "Cleaning Up",
      completed: "Deployment Complete",
      failed: "Deployment Failed",
      rolling_back: "Rolling Back",
    };
    return statusMap[status] || status;
  }, [status]);

  const progressColor = useMemo(() => {
    switch (status) {
      case "completed":
        return "bg-green-500";
      case "failed":
        return "bg-red-500";
      case "rolling_back":
        return "bg-orange-500";
      default:
        return "bg-blue-500";
    }
  }, [status]);

  const completedSteps = steps.filter(step => step.status === "completed").length;
  const totalSteps = steps.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">{statusText}</h3>
          {totalSteps > 0 && (
            <p className="text-sm text-muted-foreground">
              Step {Math.min(completedSteps + 1, totalSteps)} of {totalSteps}
            </p>
          )}
        </div>
        
        <div className="text-right">
          <div className="text-2xl font-bold">{Math.round(progress)}%</div>
          {totalSteps > 0 && (
            <div className="text-xs text-muted-foreground">
              {completedSteps}/{totalSteps} steps
            </div>
          )}
        </div>
      </div>
      
      <Progress 
        value={progress} 
        className="h-3"
        style={{
          // @ts-expect-error - Custom CSS property for progress color
          "--progress-background": progressColor.replace("bg-", ""),
        }}
      />
    </div>
  );
});
OverallProgress.displayName = "OverallProgress";

// Deployment metrics component
const DeploymentMetrics = React.memo(({
  startedAt,
  completedAt,
  downtime,
}: {
  startedAt: string;
  completedAt: string | null;
  downtime: number;
}) => {
  const { formatDateTime } = useFormattedDate();

  const elapsedTime = useMemo(() => {
    const start = new Date(startedAt);
    const end = completedAt ? new Date(completedAt) : new Date();
    const diff = end.getTime() - start.getTime();
    
    if (diff < 60000) {
      return `${Math.round(diff / 1000)}s`;
    } else {
      return `${Math.round(diff / 60000)}m ${Math.round((diff % 60000) / 1000)}s`;
    }
  }, [startedAt, completedAt]);

  const formattedDowntime = useMemo(() => {
    if (downtime === 0) return "0ms";
    if (downtime < 1000) return `${downtime}ms`;
    if (downtime < 60000) return `${(downtime / 1000).toFixed(1)}s`;
    return `${(downtime / 60000).toFixed(1)}min`;
  }, [downtime]);

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">Duration</div>
            <div className="text-2xl font-bold">{elapsedTime}</div>
            <div className="text-xs text-muted-foreground">
              Started {formatDateTime(startedAt)}
            </div>
          </div>
        </CardContent>
      </Card>
      
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">Downtime</div>
            <div className="text-2xl font-bold">{formattedDowntime}</div>
            <div className="text-xs text-muted-foreground">
              Traffic interruption
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
});
DeploymentMetrics.displayName = "DeploymentMetrics";

// Real-time log streaming component
const LogStreaming = React.memo(({ logs }: { logs: string[] }) => {
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  React.useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [logs]);

  if (!logs || logs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Real-time Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground text-center py-4">
            No logs available yet...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Real-time Logs</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48 w-full rounded border bg-muted/50 overflow-y-auto" ref={scrollAreaRef}>
          <div className="p-3 space-y-1">
            {logs.map((log, index) => (
              <div key={index} className="text-xs font-mono whitespace-pre-wrap">
                {log}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
LogStreaming.displayName = "LogStreaming";

// Main component
export const DeploymentProgress = React.memo(function DeploymentProgress({
  deploymentId,
  className,
}: DeploymentProgressProps) {
  const {
    data: statusResponse,
    isLoading,
    error,
  } = useDeploymentStatus(deploymentId, {
    refetchInterval: 2000, // Fast polling for real-time updates
  });

  const rollbackMutation = useDeploymentRollback({
    onSuccess: () => {
      toast.success("Rollback initiated successfully");
    },
    onError: (error) => {
      toast.error(`Failed to rollback: ${error.message}`);
    },
  });

  const handleRollback = useCallback(async () => {
    rollbackMutation.mutate(deploymentId);
  }, [deploymentId, rollbackMutation]);

  if (error) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <div className="text-center">
          <IconAlertTriangle className="h-8 w-8 text-red-500 mx-auto mb-4" />
          <p className="text-muted-foreground">Failed to load deployment progress</p>
          <p className="text-sm text-destructive mt-2">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  if (isLoading || !statusResponse) {
    return (
      <div className={`space-y-6 ${className}`}>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const { status, progress, steps, logs, errorMessage, startedAt, completedAt } = statusResponse.data;
  const canRollback = ["deploying", "health_checking", "switching_traffic", "failed"].includes(status);

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header with rollback button */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Deployment Progress</h2>
          <p className="text-muted-foreground">
            Monitor real-time deployment progress and view detailed step information
          </p>
        </div>
        
        {canRollback && (
          <Button
            variant="outline"
            onClick={handleRollback}
            disabled={rollbackMutation.isPending}
            className="text-orange-600 border-orange-300 hover:bg-orange-50"
          >
            <IconRotateClockwise className="h-4 w-4 mr-2" />
            {rollbackMutation.isPending ? "Rolling back..." : "Rollback"}
          </Button>
        )}
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="bg-red-50 border border-red-200 p-4 rounded">
          <div className="flex items-start gap-2">
            <IconAlertTriangle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="font-medium text-red-900">Deployment Error</h4>
              <p className="text-red-700 mt-1">{errorMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Overall progress */}
      <Card>
        <CardHeader>
          <CardTitle>Overall Progress</CardTitle>
        </CardHeader>
        <CardContent>
          <OverallProgress status={status} progress={progress} steps={steps} />
        </CardContent>
      </Card>

      {/* Step-by-step progress */}
      <Card>
        <CardHeader>
          <CardTitle>Deployment Steps</CardTitle>
        </CardHeader>
        <CardContent>
          {steps.length > 0 ? (
            <div className="space-y-0">
              {steps.map((step, index) => (
                <div key={step.id}>
                  <DeploymentStep step={step} />
                  {index < steps.length - 1 && (
                    <Separator className="ml-4" />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No deployment steps available yet...</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deployment metrics */}
      <DeploymentMetrics
        startedAt={startedAt}
        completedAt={completedAt}
        downtime={0} // Will come from backend
      />

      {/* Real-time logs */}
      <LogStreaming logs={logs} />
    </div>
  );
});