import React from "react";
import { IconCheck, IconX, IconLoader2 } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import type { ApplyResult, ServiceApplyResult } from "@mini-infra/types";

interface StackApplyProgressProps {
  /** Live mode: the list of planned actions */
  actions?: Array<{ serviceName: string; action: string }>;
  /** Live mode: results received so far */
  completedResults?: ServiceApplyResult[];
  /** Live mode: total number of actions */
  totalActions?: number;
  /** Live mode: whether the apply is still running */
  isApplying?: boolean;
  /** Completed mode: final result */
  result?: ApplyResult & { error?: string };
  className?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

export const StackApplyProgress = React.memo(function StackApplyProgress({
  actions,
  completedResults,
  totalActions,
  isApplying,
  result,
  className,
}: StackApplyProgressProps) {
  // Completed mode — show final result
  if (result) {
    const succeeded = result.serviceResults.filter((r) => r.success);

    return (
      <Card className={className}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              {result.success ? (
                <IconCheck className="h-5 w-5 text-green-500" />
              ) : (
                <IconX className="h-5 w-5 text-red-500" />
              )}
              {result.error
                ? "Apply Failed"
                : result.success
                  ? "Apply Succeeded"
                  : "Apply Partially Failed"}
            </CardTitle>
            {result.duration > 0 && (
              <Badge variant="secondary">{formatDuration(result.duration)}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {result.error
              ? result.error
              : result.success
                ? `Applied version ${result.appliedVersion} in ${formatDuration(result.duration)}`
                : `${succeeded.length} of ${result.serviceResults.length} services succeeded`}
          </p>
        </CardHeader>

        {result.serviceResults.length > 0 && (
          <CardContent className="space-y-0">
            {result.serviceResults.map((sr, index) => (
              <div key={sr.serviceName}>
                <div className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-2">
                    {sr.success ? (
                      <IconCheck className="h-4 w-4 text-green-500" />
                    ) : (
                      <IconX className="h-4 w-4 text-red-500" />
                    )}
                    <span className="font-medium">{sr.serviceName}</span>
                    <Badge variant="secondary" className="text-xs">
                      {sr.action}
                    </Badge>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {formatDuration(sr.duration)}
                  </span>
                </div>

                {sr.error && (
                  <Alert variant="destructive" className="mb-3">
                    <AlertDescription>{sr.error}</AlertDescription>
                  </Alert>
                )}

                {index < result.serviceResults.length - 1 && <Separator />}
              </div>
            ))}
          </CardContent>
        )}
      </Card>
    );
  }

  // Live progress mode
  if (!actions || !totalActions) return null;

  const completedSet = new Map(
    (completedResults ?? []).map((r) => [r.serviceName, r]),
  );
  const completedCount = completedSet.size;
  const progressPercent = totalActions > 0 ? (completedCount / totalActions) * 100 : 0;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <IconLoader2 className="h-5 w-5 animate-spin text-blue-500" />
            Applying Stack
          </CardTitle>
          <Badge variant="secondary">
            {completedCount} / {totalActions}
          </Badge>
        </div>
        <Progress value={progressPercent} className="mt-2" />
      </CardHeader>

      <CardContent className="space-y-0">
        {actions.map((action, index) => {
          const completed = completedSet.get(action.serviceName);
          const isNext =
            !completed &&
            isApplying &&
            completedCount === index;

          return (
            <div key={action.serviceName}>
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-2">
                  {completed ? (
                    completed.success ? (
                      <IconCheck className="h-4 w-4 text-green-500" />
                    ) : (
                      <IconX className="h-4 w-4 text-red-500" />
                    )
                  ) : isNext ? (
                    <IconLoader2 className="h-4 w-4 animate-spin text-blue-500" />
                  ) : (
                    <div className="h-4 w-4 rounded-full border border-muted-foreground/30" />
                  )}
                  <span
                    className={
                      completed
                        ? "font-medium"
                        : isNext
                          ? "font-medium text-blue-600 dark:text-blue-400"
                          : "text-muted-foreground"
                    }
                  >
                    {action.serviceName}
                  </span>
                  <Badge
                    variant="secondary"
                    className={`text-xs ${!completed && !isNext ? "opacity-50" : ""}`}
                  >
                    {action.action}
                  </Badge>
                </div>
                {completed && (
                  <span className="text-sm text-muted-foreground">
                    {formatDuration(completed.duration)}
                  </span>
                )}
              </div>

              {completed?.error && (
                <Alert variant="destructive" className="mb-3">
                  <AlertDescription>{completed.error}</AlertDescription>
                </Alert>
              )}

              {index < actions.length - 1 && <Separator />}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
});
