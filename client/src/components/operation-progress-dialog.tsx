/**
 * Generic operation progress dialog.
 *
 * Implements the preview → executing → result state machine pattern
 * used by Connect Container and TLS Certificate Issuance flows.
 */

import type { ReactNode } from "react";
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
  IconArrowRight,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { OperationState, OperationStep } from "@/hooks/use-operation-progress";

// ====================
// Step rendering components
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
  return <IconArrowRight className="h-4 w-4 text-muted-foreground" />;
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
  const completedMap = new Map(
    completedSteps.map((s) => [s.step, s]),
  );

  // If we have planned step names, show them all with appropriate status
  if (plannedStepNames.length > 0) {
    let foundFirstPending = false;
    return plannedStepNames.map((name) => {
      const completed = completedMap.get(name);
      if (completed) {
        return { name: completed.step, status: completed.status, detail: completed.detail };
      }
      // First non-completed step during execution is "in-progress"
      if (isExecuting && !foundFirstPending) {
        foundFirstPending = true;
        return { name, status: "in-progress" as const };
      }
      return { name, status: "pending" as const };
    });
  }

  // Fallback: no planned names, just show completed steps
  return completedSteps.map((s) => ({
    name: s.step,
    status: s.status,
    detail: s.detail,
  }));
}

function OperationStepList({
  steps,
  plannedStepNames = [],
  isExecuting = false,
}: {
  steps: OperationStep[];
  plannedStepNames?: string[];
  isExecuting?: boolean;
}) {
  const displaySteps = buildDisplaySteps(steps, plannedStepNames, isExecuting);
  if (displaySteps.length === 0) return null;

  return (
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
  );
}

// ====================
// Dialog props and component
// ====================

export interface OperationProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** Dialog title */
  title: string;
  /** Optional icon to show next to the title */
  titleIcon?: ReactNode;

  /** State from useOperationProgress */
  operationState: OperationState;

  /** Content to render in the preview/idle phase */
  previewContent: ReactNode;

  /** Footer action for the preview phase */
  onConfirm: () => void;
  confirmLabel?: string;
  confirmDisabled?: boolean;

  /** Phase-specific descriptions */
  descriptions: {
    preview: string;
    executing: string;
    success: string;
    error: string;
  };

  /** Called on close after success */
  onClose?: () => void;
}

export function OperationProgressDialog({
  open,
  onOpenChange,
  title,
  titleIcon,
  operationState,
  previewContent,
  onConfirm,
  confirmLabel = "Start",
  confirmDisabled = false,
  descriptions,
  onClose,
}: OperationProgressDialogProps) {
  const { phase, completedSteps, totalSteps, plannedStepNames, errors } = operationState;

  const handleClose = () => {
    onClose?.();
    onOpenChange(false);
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen && phase === "executing") return; // Prevent close during execution
    if (!isOpen) {
      onClose?.();
    }
    onOpenChange(isOpen);
  };

  const dialogTitle =
    phase === "success"
      ? `${title} — Complete`
      : phase === "error"
        ? `${title} — Failed`
        : title;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {titleIcon}
            {dialogTitle}
          </DialogTitle>
          <DialogDescription>{phase === "idle" ? descriptions.preview : descriptions[phase]}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-4">
          {/* Idle / Preview */}
          {phase === "idle" && previewContent}

          {/* Executing */}
          {phase === "executing" && (
            <div className="space-y-4">
              {plannedStepNames.length === 0 && (
                <div className="flex items-center justify-center py-4">
                  <IconLoader2 className="h-10 w-10 animate-spin text-primary" />
                </div>
              )}
              <OperationStepList
                steps={completedSteps}
                plannedStepNames={plannedStepNames}
                isExecuting
              />
            </div>
          )}

          {/* Success */}
          {phase === "success" && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="rounded-full bg-green-100 dark:bg-green-900 p-3">
                  <IconCheck className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
              </div>
              <OperationStepList steps={completedSteps} plannedStepNames={plannedStepNames} />
              {errors.length > 0 && (
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
          )}

          {/* Error */}
          {phase === "error" && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="rounded-full bg-red-100 dark:bg-red-900 p-3">
                  <IconX className="h-8 w-8 text-red-600 dark:text-red-400" />
                </div>
              </div>
              {errors.length > 0 && (
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
              <OperationStepList steps={completedSteps} plannedStepNames={plannedStepNames} />
            </div>
          )}
        </div>

        <DialogFooter>
          {phase === "idle" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={confirmDisabled}>
                {confirmLabel}
              </Button>
            </>
          )}

          {phase === "executing" && (
            <Button variant="outline" disabled>
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              Please Wait...
            </Button>
          )}

          {(phase === "success" || phase === "error") && (
            <Button onClick={handleClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
