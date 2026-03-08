import React from "react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import type { ApplyResult } from "@mini-infra/types";

interface StackApplyProgressProps {
  result: ApplyResult;
  className?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

export const StackApplyProgress = React.memo(function StackApplyProgress({
  result,
  className,
}: StackApplyProgressProps) {
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
            {result.success ? "Apply Succeeded" : "Apply Failed"}
          </CardTitle>
          <Badge variant="secondary">{formatDuration(result.duration)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {result.success
            ? `Applied version ${result.appliedVersion} in ${formatDuration(result.duration)}`
            : `Apply failed — ${succeeded.length} of ${result.serviceResults.length} services succeeded`}
        </p>
      </CardHeader>

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
    </Card>
  );
});
