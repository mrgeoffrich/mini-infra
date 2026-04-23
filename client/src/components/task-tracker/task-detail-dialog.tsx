/**
 * Task detail dialog — opened from the task tracker popover.
 *
 * Shows the normalized OperationState step list for any tracked task,
 * reusing the same step rendering pattern as OperationProgressDialog.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconLoader2,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconCertificate,
  IconPlug,
  IconStack2,
  IconTrash,
  IconArrowsShuffle,
  IconRocket,
  IconRefresh,
  IconShieldLock,
  IconLock,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import type { TrackedTask } from "@/lib/task-tracker-types";
import type { TaskType } from "@/lib/task-tracker-types";
import type { OperationStep } from "@/hooks/use-operation-progress";

// ====================
// Step rendering (mirrors operation-progress-dialog.tsx)
// ====================

type StepDisplayStatus = OperationStep["status"] | "pending" | "in-progress";

function StepStatusIcon({ status }: { status: StepDisplayStatus }) {
  if (status === "completed") {
    return <IconCheck className="h-4 w-4 text-green-600 dark:text-green-400" />;
  }
  if (status === "failed") {
    return <IconX className="h-4 w-4 text-red-600 dark:text-red-400" />;
  }
  if (status === "in-progress") {
    return <IconLoader2 className="h-4 w-4 animate-spin text-primary" />;
  }
  if (status === "pending") {
    return <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />;
  }
  return null;
}

interface DisplayStep {
  name: string;
  status: StepDisplayStatus;
  detail?: string;
}

function buildDisplaySteps(
  completedSteps: OperationStep[],
  plannedStepNames: string[],
  isExecuting: boolean,
): DisplayStep[] {
  const completedMap = new Map(completedSteps.map((s) => [s.step, s]));

  if (plannedStepNames.length > 0) {
    let foundFirstPending = false;
    return plannedStepNames.map((name) => {
      const completed = completedMap.get(name);
      if (completed) {
        return { name: completed.step, status: completed.status, detail: completed.detail };
      }
      if (isExecuting && !foundFirstPending) {
        foundFirstPending = true;
        return { name, status: "in-progress" as const };
      }
      return { name, status: "pending" as const };
    });
  }

  return completedSteps.map((s) => ({
    name: s.step,
    status: s.status,
    detail: s.detail,
  }));
}

// ====================
// Helpers
// ====================

function getTaskTitle(type: TaskType): string {
  switch (type) {
    case "cert-issuance":
      return "Certificate Issuance";
    case "connect-container":
      return "Connect Container";
    case "stack-apply":
      return "Stack Apply";
    case "stack-destroy":
      return "Stack Destroy";
    case "stack-update":
      return "Stack Update";
    case "migration":
      return "HAProxy Migration";
    case "sidecar-startup":
      return "Agent Sidecar Startup";
    case "self-update-launch":
      return "Self-Update Launch";
    case "vault-bootstrap":
      return "Vault Bootstrap";
    case "vault-unseal":
      return "Vault Unseal";
  }
}

function getTaskIcon(type: TaskType) {
  switch (type) {
    case "cert-issuance":
      return <IconCertificate className="h-5 w-5" />;
    case "connect-container":
      return <IconPlug className="h-5 w-5" />;
    case "stack-apply":
      return <IconStack2 className="h-5 w-5" />;
    case "stack-destroy":
      return <IconTrash className="h-5 w-5" />;
    case "stack-update":
      return <IconRefresh className="h-5 w-5" />;
    case "migration":
      return <IconArrowsShuffle className="h-5 w-5" />;
    case "sidecar-startup":
      return <IconRocket className="h-5 w-5" />;
    case "self-update-launch":
      return <IconRefresh className="h-5 w-5" />;
    case "vault-bootstrap":
      return <IconShieldLock className="h-5 w-5" />;
    case "vault-unseal":
      return <IconLock className="h-5 w-5" />;
  }
}

// ====================
// TaskDetailDialog
// ====================

interface TaskDetailDialogProps {
  task: TrackedTask | null;
  onClose: () => void;
}

export function TaskDetailDialog({ task, onClose }: TaskDetailDialogProps) {
  const { dismissTask, getTask } = useTaskTracker();

  // Use live task from context so progress updates in real time
  const liveTask = task ? (getTask(task.id) ?? task) : null;

  if (!liveTask) return null;

  const { operationState } = liveTask;
  const { phase, completedSteps, plannedStepNames, errors } = operationState;
  const isExecuting = phase === "executing";
  const displaySteps = buildDisplaySteps(completedSteps, plannedStepNames, isExecuting);

  const phaseTitle =
    phase === "success"
      ? `${getTaskTitle(liveTask.type)} — Complete`
      : phase === "error"
        ? `${getTaskTitle(liveTask.type)} — Failed`
        : getTaskTitle(liveTask.type);

  const handleDismiss = () => {
    dismissTask(liveTask.id);
    onClose();
  };

  return (
    <Dialog open={!!task} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {getTaskIcon(liveTask.type)}
            {phaseTitle}
          </DialogTitle>
          <DialogDescription>{liveTask.label}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-4 space-y-4">
          {/* Phase indicator */}
          {phase === "executing" && displaySteps.length === 0 && (
            <div className="flex items-center justify-center py-4">
              <IconLoader2 className="h-10 w-10 animate-spin text-primary" />
            </div>
          )}

          {phase === "success" && (
            <div className="flex items-center justify-center py-4">
              <div className="rounded-full bg-green-100 dark:bg-green-900 p-3">
                <IconCheck className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="flex items-center justify-center py-4">
              <div className="rounded-full bg-red-100 dark:bg-red-900 p-3">
                <IconX className="h-8 w-8 text-red-600 dark:text-red-400" />
              </div>
            </div>
          )}

          {/* Step list */}
          {displaySteps.length > 0 && (
            <div className="rounded-md border p-4 space-y-1">
              {displaySteps.map((step, i) => (
                <div
                  key={step.name || i}
                  className="flex items-start gap-2 text-sm p-1.5 rounded"
                >
                  <StepStatusIcon status={step.status} />
                  <div className="flex-1">
                    <span
                      className={cn(
                        "font-medium",
                        step.status === "failed" && "text-red-600 dark:text-red-400",
                        step.status === "pending" && "text-muted-foreground",
                      )}
                    >
                      {step.name}
                    </span>
                    {step.detail && (
                      <span className="text-muted-foreground ml-1">
                        — {step.detail}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Errors */}
          {errors.length > 0 && phase === "error" && (
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <ul className="text-sm space-y-1">
                  {errors.map((error, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <IconX className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>{error}</span>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Warnings on success */}
          {errors.length > 0 && phase === "success" && (
            <Alert className="bg-yellow-50 dark:bg-yellow-950 border-yellow-200">
              <IconAlertTriangle className="h-4 w-4 text-yellow-600" />
              <AlertDescription>
                <div className="font-medium mb-1">Warnings:</div>
                <ul className="text-sm list-disc list-inside">
                  {errors.map((error, i) => (
                    <li key={i}>{error}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          {isExecuting && (
            <Button variant="outline" onClick={onClose}>
              Minimize
            </Button>
          )}
          {!isExecuting && (
            <>
              <Button variant="outline" onClick={handleDismiss}>
                Dismiss
              </Button>
              <Button onClick={onClose}>Close</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
