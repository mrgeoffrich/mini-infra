import React, { useMemo, useState, useCallback } from "react";
import {
  IconRefresh,
  IconCheck,
  IconAlertTriangle,
  IconRocket,
} from "@tabler/icons-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useStackPlan, useStackApply, useStackApplyProgress } from "@/hooks/use-stacks";
import { ServiceActionRow } from "./ServiceActionRow";
import { StackApplyProgress } from "./StackApplyProgress";

interface StackPlanViewProps {
  stackId: string;
  className?: string;
}

const ACTION_PRIORITY: Record<string, number> = {
  create: 0,
  recreate: 1,
  remove: 2,
  "no-op": 3,
};

export const StackPlanView = React.memo(function StackPlanView({
  stackId,
  className,
}: StackPlanViewProps) {
  const {
    data: planResponse,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useStackPlan(stackId);
  const applyMutation = useStackApply();
  const applyProgress = useStackApplyProgress(stackId);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set(),
  );

  const plan = planResponse?.data;

  const sortedActions = useMemo(() => {
    if (!plan?.actions) return [];
    return [...plan.actions].sort(
      (a, b) =>
        (ACTION_PRIORITY[a.action] ?? 99) - (ACTION_PRIORITY[b.action] ?? 99),
    );
  }, [plan?.actions]);

  const counts = useMemo(() => {
    if (!plan?.actions) return { create: 0, recreate: 0, remove: 0, "no-op": 0 };
    const c = { create: 0, recreate: 0, remove: 0, "no-op": 0 };
    for (const action of plan.actions) {
      c[action.action]++;
    }
    return c;
  }, [plan?.actions]);

  const hasSelectableActions = counts.create + counts.recreate + counts.remove > 0;

  const handleSelect = useCallback(
    (serviceName: string, selected: boolean) => {
      setSelectedServices((prev) => {
        const next = new Set(prev);
        if (selected) {
          next.add(serviceName);
        } else {
          next.delete(serviceName);
        }
        return next;
      });
    },
    [],
  );

  const handleApplyAll = useCallback(() => {
    applyMutation.mutate({ stackId, options: {} });
  }, [stackId, applyMutation]);

  const handleApplySelected = useCallback(() => {
    applyMutation.mutate({
      stackId,
      options: { serviceNames: Array.from(selectedServices) },
    });
  }, [stackId, selectedServices, applyMutation]);

  // Show live progress or final result from socket events
  if (applyProgress.isApplying || applyProgress.finalResult) {
    return (
      <div className={className}>
        <StackApplyProgress
          isApplying={applyProgress.isApplying}
          actions={applyProgress.actions}
          completedResults={applyProgress.completedResults}
          totalActions={applyProgress.totalActions}
          result={applyProgress.finalResult ?? undefined}
        />
        {applyProgress.finalResult && (
          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                applyProgress.reset();
                refetch();
              }}
            >
              <IconRefresh className="h-4 w-4 mr-2" />
              View Updated Plan
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className={`space-y-4 ${className ?? ""}`}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  // Error state
  if (error) {
    const isDockerUnavailable = error.message.includes("Docker is unavailable");
    return (
      <Alert variant="destructive" className={className}>
        <IconAlertTriangle className="h-4 w-4" />
        <AlertTitle>
          {isDockerUnavailable ? "Docker Unavailable" : "Plan Error"}
        </AlertTitle>
        <AlertDescription>
          {isDockerUnavailable
            ? "Cannot compute plan because Docker is not available. Ensure the Docker daemon is running."
            : error.message}
        </AlertDescription>
      </Alert>
    );
  }

  // No plan data
  if (!plan) return null;

  // No changes needed
  if (!plan.hasChanges) {
    return (
      <Card className={className}>
        <CardContent className="flex items-center gap-3 py-8 justify-center">
          <IconCheck className="h-6 w-6 text-green-500" />
          <div>
            <p className="font-medium">Stack is in sync</p>
            <p className="text-sm text-muted-foreground">
              No changes needed — all services match the desired state.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-4"
            onClick={handleApplyAll}
            disabled={applyMutation.isPending}
          >
            <IconRefresh className="h-4 w-4 mr-2" />
            {applyMutation.isPending ? "Syncing..." : "Sync Anyway"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={`space-y-4 ${className ?? ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">
            {plan.stackName}{" "}
            <span className="text-muted-foreground font-normal">
              v{plan.stackVersion}
            </span>
          </h3>
          <p className="text-sm text-muted-foreground">
            Plan computed{" "}
            {new Date(plan.planTime).toLocaleTimeString()}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <IconRefresh
            className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh Plan
        </Button>
      </div>

      {/* Summary badges */}
      <div className="flex gap-2 flex-wrap">
        {counts.create > 0 && (
          <Badge className="bg-green-500 text-white">
            {counts.create} create
          </Badge>
        )}
        {counts.recreate > 0 && (
          <Badge className="bg-orange-500 text-white">
            {counts.recreate} recreate
          </Badge>
        )}
        {counts.remove > 0 && (
          <Badge className="bg-red-500 text-white">
            {counts.remove} remove
          </Badge>
        )}
        {counts["no-op"] > 0 && (
          <Badge variant="secondary">{counts["no-op"]} unchanged</Badge>
        )}
      </div>

      {/* Service action list */}
      <Card>
        <CardContent className="py-2">
          {sortedActions.map((action, index) => (
            <div key={action.serviceName}>
              <ServiceActionRow
                action={action}
                selected={selectedServices.has(action.serviceName)}
                onSelect={handleSelect}
                showCheckbox={hasSelectableActions}
              />
              {index < sortedActions.length - 1 && <Separator />}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Apply buttons */}
      <div className="flex gap-2">
        <Button
          onClick={handleApplyAll}
          disabled={applyMutation.isPending}
        >
          <IconRocket className="h-4 w-4 mr-2" />
          {applyMutation.isPending ? "Starting..." : "Apply All"}
        </Button>
        {selectedServices.size > 0 && (
          <Button
            variant="outline"
            onClick={handleApplySelected}
            disabled={applyMutation.isPending}
          >
            Apply Selected ({selectedServices.size})
          </Button>
        )}
      </div>
    </div>
  );
});
