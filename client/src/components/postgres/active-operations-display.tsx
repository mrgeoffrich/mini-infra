import { useState } from "react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Activity,
  AlertCircle,
  Database,
  Zap,
  X,
  Eye,
  EyeOff,
} from "lucide-react";
import { useActiveOperationsStatus } from "@/hooks/use-postgres-progress";
import {
  OperationStatusBadge,
  OperationTypeBadge,
  ProgressBadge,
} from "./operation-status-badge";
import type {
  BackupOperationProgress,
  RestoreOperationProgress,
} from "@mini-infra/types";

interface OperationProgressCardProps {
  operation: BackupOperationProgress | RestoreOperationProgress;
  type: "backup" | "restore";
  onCancel?: (operationId: string) => void;
  showDetails?: boolean;
}

function OperationProgressCard({
  operation,
  type,
  onCancel,
  showDetails = false,
}: OperationProgressCardProps) {
  const [isExpanded, setIsExpanded] = useState(showDetails);
  const { formatDateTime, formatTime } = useFormattedDate();

  const isActive =
    operation.status === "pending" || operation.status === "running";
  const progressValue = Math.max(0, Math.min(100, operation.progress));

  const getEstimatedTimeRemaining = () => {
    if (!operation.estimatedCompletion || operation.status !== "running") {
      return null;
    }

    const now = new Date().getTime();
    const estimated = new Date(operation.estimatedCompletion).getTime();
    const remaining = estimated - now;

    if (remaining <= 0) return "Almost done...";
    if (remaining < 60000) return `~${Math.round(remaining / 1000)}s remaining`;
    if (remaining < 3600000)
      return `~${Math.round(remaining / 60000)}m remaining`;
    return `~${Math.round(remaining / 3600000)}h remaining`;
  };

  const estimatedTime = getEstimatedTimeRemaining();

  return (
    <Card
      className={`transition-all ${isActive ? "ring-2 ring-blue-200" : ""}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <OperationTypeBadge
                type={type}
                operationType={
                  "operationType" in operation
                    ? (operation.operationType as string)
                    : undefined
                }
                variant="compact"
              />
              <OperationStatusBadge
                status={operation.status}
                variant="compact"
              />
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {onCancel && isActive && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCancel(operation.id)}
                className="text-red-600 hover:text-red-700"
              >
                <X className="w-4 h-4" />
              </Button>
            )}
            <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  {isExpanded ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </Button>
              </CollapsibleTrigger>
            </Collapsible>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Operation Progress</span>
            <ProgressBadge progress={progressValue} variant="compact" />
          </div>

          <Progress value={progressValue} className="h-2" />

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center space-x-4">
              <span>Started: {formatTime(operation.startedAt)}</span>
              {operation.currentStep && (
                <span>Step: {operation.currentStep}</span>
              )}
            </div>
            {estimatedTime && (
              <span className="text-blue-600">{estimatedTime}</span>
            )}
          </div>
        </div>
      </CardHeader>

      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="font-medium text-muted-foreground">
                    Operation ID:
                  </span>
                  <div className="font-mono text-xs mt-1 break-all">
                    {operation.id}
                  </div>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">
                    Database ID:
                  </span>
                  <div className="font-mono text-xs mt-1 break-all">
                    {operation.databaseId}
                  </div>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">
                    Started At:
                  </span>
                  <div className="mt-1">
                    {formatDateTime(operation.startedAt)}
                  </div>
                </div>
                {operation.estimatedCompletion && (
                  <div>
                    <span className="font-medium text-muted-foreground">
                      Estimated Completion:
                    </span>
                    <div className="mt-1">
                      {formatDateTime(operation.estimatedCompletion)}
                    </div>
                  </div>
                )}
              </div>

              {/* Progress Steps */}
              {operation.totalSteps && operation.totalSteps > 1 && (
                <div>
                  <span className="font-medium text-muted-foreground text-sm">
                    Progress Steps:
                  </span>
                  <div className="mt-2 flex items-center space-x-2">
                    <div className="flex-1 bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all"
                        style={{
                          width: `${
                            operation.completedSteps
                              ? (operation.completedSteps /
                                  operation.totalSteps) *
                                100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {operation.completedSteps || 0} / {operation.totalSteps}
                    </span>
                  </div>
                  {operation.currentStep && (
                    <div className="text-xs text-muted-foreground mt-1">
                      Current: {operation.currentStep}
                    </div>
                  )}
                </div>
              )}

              {/* Restore specific info */}
              {type === "restore" && "backupUrl" in operation && (
                <div>
                  <span className="font-medium text-muted-foreground text-sm">
                    Backup Source:
                  </span>
                  <div className="font-mono text-xs mt-1 break-all bg-muted p-2 rounded">
                    {operation.backupUrl}
                  </div>
                </div>
              )}

              {/* Error information */}
              {operation.errorMessage && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-sm">
                    <span className="font-medium">Error:</span>{" "}
                    {operation.errorMessage}
                  </AlertDescription>
                </Alert>
              )}

              {/* Metadata */}
              {operation.metadata &&
                Object.keys(operation.metadata).length > 0 && (
                  <div>
                    <span className="font-medium text-muted-foreground text-sm">
                      Additional Info:
                    </span>
                    <div className="mt-1 bg-muted p-2 rounded text-xs">
                      <pre className="whitespace-pre-wrap">
                        {JSON.stringify(operation.metadata, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

interface ActiveOperationsDisplayProps {
  databaseId?: string;
  showHeader?: boolean;
  maxHeight?: string;
  onCancelOperation?: (operationId: string) => void;
  className?: string;
}

export function ActiveOperationsDisplay({
  databaseId,
  showHeader = true,
  maxHeight = "400px",
  onCancelOperation,
  className,
}: ActiveOperationsDisplayProps) {
  const {
    isLoading,
    error,
    hasAnyActive,
    backupOperations,
    restoreOperations,
  } = useActiveOperationsStatus();

  // Filter operations by database if specified
  const filteredBackups = databaseId
    ? backupOperations.filter((op) => op.databaseId === databaseId)
    : backupOperations;

  const filteredRestores = databaseId
    ? restoreOperations.filter((op) => op.databaseId === databaseId)
    : restoreOperations;

  const filteredTotalActive = filteredBackups.length + filteredRestores.length;
  const hasFilteredActive = filteredTotalActive > 0;

  if (isLoading && !hasAnyActive) {
    return (
      <Card className={className}>
        {showHeader && (
          <CardHeader>
            <CardTitle className="flex items-center">
              <Activity className="w-5 h-5 mr-2" />
              Active Operations
            </CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <div className="space-y-4">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-16" />
                </div>
                <Skeleton className="h-2 w-full" />
                <div className="flex justify-between">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        {showHeader && (
          <CardHeader>
            <CardTitle className="flex items-center">
              <Activity className="w-5 h-5 mr-2" />
              Active Operations
            </CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load active operations: {error.message}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!hasFilteredActive) {
    return (
      <Card className={className}>
        {showHeader && (
          <CardHeader>
            <CardTitle className="flex items-center">
              <Activity className="w-5 h-5 mr-2" />
              Active Operations
            </CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <div className="text-center py-8">
            <Database className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No active operations</h3>
            <p className="text-muted-foreground">
              {databaseId
                ? "No backup or restore operations are currently running for this database."
                : "No backup or restore operations are currently running."}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      {showHeader && (
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center">
              <Activity className="w-5 h-5 mr-2" />
              Active Operations
              <Badge variant="outline" className="ml-2">
                <Zap className="w-3 h-3 mr-1" />
                {filteredTotalActive}
              </Badge>
            </CardTitle>
          </div>
        </CardHeader>
      )}

      <CardContent>
        <div style={{ maxHeight }} className="overflow-y-auto space-y-4">
          {/* Active Backup Operations */}
          {filteredBackups.map((operation) => (
            <OperationProgressCard
              key={operation.id}
              operation={operation}
              type="backup"
              onCancel={onCancelOperation}
            />
          ))}

          {/* Active Restore Operations */}
          {filteredRestores.map((operation) => (
            <OperationProgressCard
              key={operation.id}
              operation={operation}
              type="restore"
              onCancel={onCancelOperation}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function ActiveOperationsIndicator({
  className,
}: {
  className?: string;
}) {
  const { isLoading, hasAnyActive, totalActiveCount } =
    useActiveOperationsStatus();

  if (isLoading || !hasAnyActive) {
    return null;
  }

  return (
    <Badge
      variant="outline"
      className={`${className} text-blue-700 border-blue-200 bg-blue-50 animate-pulse`}
    >
      <Activity className="w-3 h-3 mr-1 animate-spin" />
      {totalActiveCount} active operation{totalActiveCount !== 1 ? "s" : ""}
    </Badge>
  );
}
