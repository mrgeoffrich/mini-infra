import React, { useMemo, useState, useCallback, useEffect } from "react";
import {
  IconRefresh,
  IconCheck,
  IconAlertTriangle,
  IconRocket,
  IconCloudDownload,
  IconTrash,
  IconLoader2,
} from "@tabler/icons-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Channel } from "@mini-infra/types";
import type { StackParameterValue } from "@mini-infra/types";
import { useStackPlan, useStackApply, useStackApplyProgress, useStackDestroy, useStackDestroyProgress, useStackValidation, useStack, useUpdateStackParameterValues } from "@/hooks/use-stacks";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { ServiceActionRow } from "./ServiceActionRow";
import { StackApplyProgress } from "./StackApplyProgress";
import { StackParametersDialog } from "./StackParametersDialog";
import { PoolServiceRow } from "./PoolServiceRow";

interface StackPlanViewProps {
  stackId: string;
  className?: string;
  onDestroyCompleted?: () => void;
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
  onDestroyCompleted,
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
  const destroyMutation = useStackDestroy();
  const destroyProgress = useStackDestroyProgress(stackId);
  const { registerTask } = useTaskTracker();
  const { data: stackResponse } = useStack(stackId);
  const stackInfo = stackResponse?.data;
  const updateParamsMutation = useUpdateStackParameterValues();
  const [showParamsDialog, setShowParamsDialog] = useState(false);

  useEffect(() => {
    if (destroyProgress.result?.success) {
      onDestroyCompleted?.();
    }
  }, [destroyProgress.result?.success, onDestroyCompleted]);
  const { data: validation } = useStackValidation(stackId);
  const hasValidationErrors = validation && !validation.valid;
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set(),
  );

  const plan = planResponse?.data;

  const sortedActions = !plan?.actions
    ? []
    : [...plan.actions].sort(
        (a, b) =>
          (ACTION_PRIORITY[a.action] ?? 99) -
          (ACTION_PRIORITY[b.action] ?? 99),
      );

  const counts = !plan?.actions
    ? { create: 0, recreate: 0, remove: 0, "no-op": 0 }
    : plan.actions.reduce(
        (acc, action) => {
          acc[action.action]++;
          return acc;
        },
        { create: 0, recreate: 0, remove: 0, "no-op": 0 } as Record<
          "create" | "recreate" | "remove" | "no-op",
          number
        >,
      );

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

  const stackName = plan?.stackName ?? stackId;

  const activeResourceActions = useMemo(() => {
    return (plan?.resourceActions ?? [])
      .filter((ra) => ra.action !== "no-op")
      .map((ra) => ({ serviceName: `${ra.resourceType}:${ra.resourceName}`, action: ra.action }));
  }, [plan?.resourceActions]);

  const triggerApplyAll = useCallback(() => {
    applyMutation.mutate({ stackId, options: {} });
    const serviceSteps = plan?.actions.filter((a) => a.action !== "no-op").map((a) => `${a.action} ${a.serviceName}`) ?? [];
    const resourceSteps = activeResourceActions.map((a) => `${a.action} ${a.serviceName}`);
    registerTask({
      id: stackId,
      type: "stack-apply",
      label: `Applying ${stackName}`,
      channel: Channel.STACKS,
      totalSteps: serviceSteps.length + resourceSteps.length,
      plannedStepNames: [...serviceSteps, ...resourceSteps],
    });
  }, [stackId, applyMutation, registerTask, stackName, plan, activeResourceActions]);

  const handleApplyAll = useCallback(() => {
    const isFirstDeploy = stackInfo?.lastAppliedVersion === null;
    const hasParameters = (stackInfo?.parameters?.length ?? 0) > 0;
    if (isFirstDeploy && hasParameters) {
      setShowParamsDialog(true);
      return;
    }
    triggerApplyAll();
  }, [stackInfo, triggerApplyAll]);

  const handleSaveAndDeploy = useCallback((parameterValues: Record<string, StackParameterValue>) => {
    updateParamsMutation.mutate({ stackId, parameterValues }, {
      onSuccess: () => {
        setShowParamsDialog(false);
        triggerApplyAll();
      },
    });
  }, [stackId, updateParamsMutation, triggerApplyAll]);

  const handleRedeploy = useCallback(() => {
    applyMutation.mutate({ stackId, options: { forcePull: true } });
    registerTask({
      id: stackId,
      type: "stack-apply",
      label: `Redeploying ${stackName}`,
      channel: Channel.STACKS,
      totalSteps: (plan?.actions.length ?? 0) + activeResourceActions.length,
    });
  }, [stackId, applyMutation, registerTask, stackName, plan, activeResourceActions]);

  const handleApplySelected = useCallback(() => {
    applyMutation.mutate({
      stackId,
      options: { serviceNames: Array.from(selectedServices) },
    });
    registerTask({
      id: stackId,
      type: "stack-apply",
      label: `Applying ${selectedServices.size} service(s) in ${stackName}`,
      channel: Channel.STACKS,
      totalSteps: selectedServices.size + activeResourceActions.length,
    });
  }, [stackId, selectedServices, applyMutation, registerTask, stackName, activeResourceActions]);

  const handleDestroy = useCallback(() => {
    destroyMutation.mutate(stackId);
    registerTask({
      id: stackId,
      type: "stack-destroy",
      label: `Destroying ${stackName}`,
      channel: Channel.STACKS,
      totalSteps: 1,
      plannedStepNames: ["Destroy stack"],
    });
  }, [stackId, destroyMutation, registerTask, stackName]);

  // Show destroy in progress
  if (destroyProgress.destroying) {
    return (
      <Card className={className}>
        <CardContent className="flex items-center gap-3 py-8 justify-center">
          <IconLoader2 className="h-6 w-6 animate-spin text-destructive" />
          <div>
            <p className="font-medium">Destroying stack...</p>
            <p className="text-sm text-muted-foreground">
              Removing containers, networks, and volumes.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show destroy result
  if (destroyProgress.result) {
    const r = destroyProgress.result;
    return (
      <Card className={className}>
        <CardContent className="py-8 space-y-3">
          <div className="flex items-center gap-3 justify-center">
            {r.success ? (
              <IconCheck className="h-6 w-6 text-green-500" />
            ) : (
              <IconAlertTriangle className="h-6 w-6 text-destructive" />
            )}
            <div>
              <p className="font-medium">
                {r.success ? "Stack destroyed" : "Destroy failed"}
              </p>
              {r.success && (
                <p className="text-sm text-muted-foreground">
                  Removed {r.containersRemoved} container{r.containersRemoved !== 1 ? "s" : ""},
                  {" "}{r.networksRemoved.length} network{r.networksRemoved.length !== 1 ? "s" : ""},
                  {" "}{r.volumesRemoved.length} volume{r.volumesRemoved.length !== 1 ? "s" : ""}.
                </p>
              )}
              {r.error && (
                <p className="text-sm text-destructive">{r.error}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show live progress or final result from socket events
  if (applyProgress.isApplying || applyProgress.finalResult) {
    return (
      <div className={className}>
        <StackApplyProgress
          isApplying={applyProgress.isApplying}
          actions={applyProgress.actions}
          completedResults={applyProgress.completedResults}
          totalActions={applyProgress.totalActions}
          forcePull={applyProgress.forcePull}
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
    const errWithMeta = error as Error & {
      code?: string;
      missing?: Array<{ resource: string; settings: string[]; settingsUrl: string; reason: string }>;
    };
    const isMissingConfig = errWithMeta.code === "MISSING_CONFIGURATION" && Array.isArray(errWithMeta.missing);

    if (isMissingConfig) {
      return (
        <Alert variant="destructive" className={className}>
          <IconAlertTriangle className="h-4 w-4" />
          <AlertTitle>Configuration required</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>This stack has external-resource requirements that aren&apos;t configured yet.</p>
            <ul className="list-disc pl-5 space-y-1">
              {errWithMeta.missing!.map((m) => (
                <li key={m.resource}>
                  <span className="font-medium">{m.reason}</span>{" "}
                  <span>Configure: {m.settings.join(", ")}.</span>{" "}
                  <a href={m.settingsUrl} className="underline">
                    Open settings
                  </a>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      );
    }

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
    const poolServices = stackInfo?.services?.filter((s) => s.serviceType === 'Pool') ?? [];
    return (
      <>
        <StackParametersDialog
          open={showParamsDialog}
          onOpenChange={setShowParamsDialog}
          stackName={stackName}
          parameters={stackInfo?.parameters ?? []}
          currentValues={stackInfo?.parameterValues ?? {}}
          onConfirm={handleSaveAndDeploy}
          isSaving={updateParamsMutation.isPending}
        />
        {poolServices.length > 0 && (
          <div className={`space-y-2 mb-4 ${className ?? ""}`}>
            <h4 className="text-sm font-semibold text-muted-foreground">
              Pool services
            </h4>
            <div className="space-y-2">
              {poolServices.map((svc) => (
                <PoolServiceRow
                  key={svc.id}
                  stackId={stackId}
                  service={svc}
                />
              ))}
            </div>
          </div>
        )}
        <Card className={className}>
        <CardContent className="flex items-center gap-3 py-8 justify-center">
          <IconCheck className="h-6 w-6 text-green-500" />
          <div>
            <p className="font-medium">Stack is in sync</p>
            <p className="text-sm text-muted-foreground">
              No changes needed — all services match the desired state.
            </p>
          </div>
          <div className="ml-4 flex gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={applyMutation.isPending || destroyMutation.isPending || !!hasValidationErrors}
                >
                  <IconCloudDownload className="h-4 w-4 mr-2" />
                  {applyMutation.isPending ? "Pulling..." : "Redeploy Containers"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Redeploy Containers</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-3">
                      <p>
                        This will pull the latest image for each service and recreate
                        any containers where the image has changed.
                      </p>
                      <div className="rounded-md border p-3 space-y-1.5">
                        {sortedActions.map((a) => (
                          <div key={a.serviceName} className="flex items-center justify-between text-sm">
                            <span className="font-medium">{a.serviceName}</span>
                            <span className="text-muted-foreground font-mono text-xs truncate ml-4 max-w-[260px]">
                              {a.desiredImage ?? a.currentImage ?? "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Services with unchanged images will not be restarted.
                      </p>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRedeploy}>
                    Pull &amp; Redeploy
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleApplyAll}
              disabled={applyMutation.isPending || destroyMutation.isPending || !!hasValidationErrors}
            >
              <IconRefresh className="h-4 w-4 mr-2" />
              Sync Anyway
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={applyMutation.isPending || destroyMutation.isPending}
                >
                  <IconTrash className="h-4 w-4 mr-2" />
                  Uninstall
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Uninstall Stack</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently destroy all containers, networks, and
                    volumes for this stack. Data stored in volumes will be lost.
                    This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDestroy}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Destroy Stack
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
      </>
    );
  }

  return (
    <>
      <StackParametersDialog
        open={showParamsDialog}
        onOpenChange={setShowParamsDialog}
        stackName={stackName}
        parameters={stackInfo?.parameters ?? []}
        currentValues={stackInfo?.parameterValues ?? {}}
        onConfirm={handleSaveAndDeploy}
        isSaving={updateParamsMutation.isPending}
      />
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

      {/* Pool services — on-demand instance templates, live instance list.
          Rendered below the standard action list because pool services are
          always no-op at plan time and have their own lifecycle. */}
      {stackInfo?.services && stackInfo.services.some((s) => s.serviceType === 'Pool') && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-muted-foreground">
            Pool services
          </h4>
          <div className="space-y-2">
            {stackInfo.services
              .filter((s) => s.serviceType === 'Pool')
              .map((svc) => (
                <PoolServiceRow
                  key={svc.id}
                  stackId={stackId}
                  service={svc}
                />
              ))}
          </div>
        </div>
      )}

      {/* Validation warning */}
      {hasValidationErrors && (
        <Alert variant="destructive">
          <IconAlertTriangle className="h-4 w-4" />
          <AlertTitle>Missing Parameters</AlertTitle>
          <AlertDescription>
            The following parameters must be configured before applying:{" "}
            {validation.errors.map((e) => e.description || e.name).join(", ")}
          </AlertDescription>
        </Alert>
      )}

      {/* Apply buttons */}
      <div className="flex gap-2">
        <Button
          onClick={handleApplyAll}
          disabled={applyMutation.isPending || destroyMutation.isPending || !!hasValidationErrors}
        >
          <IconRocket className="h-4 w-4 mr-2" />
          {applyMutation.isPending ? "Starting..." : "Apply All"}
        </Button>
        {selectedServices.size > 0 && (
          <Button
            variant="outline"
            onClick={handleApplySelected}
            disabled={applyMutation.isPending || destroyMutation.isPending || !!hasValidationErrors}
          >
            Apply Selected ({selectedServices.size})
          </Button>
        )}
        <div className="ml-auto">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={applyMutation.isPending || destroyMutation.isPending}
              >
                <IconTrash className="h-4 w-4 mr-2" />
                Uninstall
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Uninstall Stack</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently destroy all containers, networks, and
                  volumes for this stack. Data stored in volumes will be lost.
                  This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDestroy}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Destroy Stack
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
    </>
  );
});
