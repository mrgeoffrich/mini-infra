import { IconAlertTriangle, IconCheck, IconLoader2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import {
  DEPLOYMENT_PHASE_LABELS,
  DEPLOYMENT_PHASE_SEQUENCE,
  type DeploymentPhaseEvent,
} from "@mini-infra/types";

/**
 * The blue-green phases of one StatelessWeb service's deploy, with the current
 * one highlighted.
 *
 * Zero-downtime deploys are the slowest thing the apply pipeline does — deploy
 * green, wait for health, cut traffic over, drain blue — and until now none of it
 * was visible: the state machine only logged, so the UI showed a single spinning
 * row for the entire run and the operator had no idea whether it was stuck
 * pulling an image or waiting out a drain.
 *
 * The cut-over marker is the load-bearing bit. Before traffic switches, a failure
 * rolls back and nothing user-visible happened. After it, the new version is live
 * and there is no going back — that is a genuinely different situation for whoever
 * is watching, so it is called out rather than left as an undifferentiated
 * progress bar.
 */
export function DeploymentPhaseTrail({
  phase,
  className,
}: {
  phase: DeploymentPhaseEvent;
  className?: string;
}) {
  if (phase.phase === "rolling-back" || phase.phase === "failed") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400",
          className,
        )}
        data-tour="stack-deployment-phase"
      >
        <IconAlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {phase.phase === "rolling-back"
            ? "Rolling back — the new containers didn't come up, so traffic stays on the old ones."
            : "Deployment failed."}
        </span>
      </div>
    );
  }

  const currentIndex = DEPLOYMENT_PHASE_SEQUENCE.indexOf(phase.phase);

  return (
    <div className={cn("space-y-1", className)} data-tour="stack-deployment-phase">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {DEPLOYMENT_PHASE_SEQUENCE.filter((p) => p !== "completed").map((p, i) => {
          const done = currentIndex > i;
          const active = currentIndex === i;

          return (
            <div
              key={p}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
                active && "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300",
                done && "text-muted-foreground",
                !done && !active && "text-muted-foreground/50",
              )}
            >
              {done ? (
                <IconCheck className="h-3 w-3" />
              ) : active ? (
                <IconLoader2 className="h-3 w-3 animate-spin" />
              ) : (
                <div className="h-1.5 w-1.5 rounded-full border border-current" />
              )}
              {DEPLOYMENT_PHASE_LABELS[p]}
            </div>
          );
        })}
      </div>
      {phase.cutOver && (
        <p className="text-xs text-muted-foreground">
          Traffic is on the new containers — this deploy can no longer be rolled
          back automatically.
        </p>
      )}
    </div>
  );
}
