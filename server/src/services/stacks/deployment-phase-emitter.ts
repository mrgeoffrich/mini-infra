/**
 * Maps blue-green state-machine states onto user-facing deployment phases and
 * emits them on the STACKS channel.
 *
 * The map lives here rather than as `meta` on the machine for the same reason
 * `stack-destroy-helpers.ts` keeps its progress map outside the removal machine:
 * four machines share the runner, their state names differ, and the runner should
 * not have to know any of them. Presentation stays out of the machines.
 *
 * Unknown states map to `null` and emit nothing. That is deliberate — a machine
 * gaining an internal state should be silent, not surface a raw state name like
 * `decommissioningBlueLB` to an operator.
 */
import type { DeploymentPhase } from "@mini-infra/types";
import { DEPLOYMENT_PHASE_LABELS, Channel, ServerEvent } from "@mini-infra/types";
import { emitToChannel } from "../../lib/socket";
import { getLogger } from "../../lib/logger-factory";

const log = getLogger("deploy", "deployment-phase-emitter");

/**
 * Machine state → phase, covering BOTH blue-green machines: `blueGreenUpdateMachine`
 * (a redeploy of an existing service) and `blueGreenDeploymentMachine` (a
 * recreate). Their state names are identical bar two, so one map serves both —
 * `configuringFrontend` and `rollbackDisableGreenTraffic` exist only on the
 * recreate machine and are included here.
 *
 * Several machine states collapse into one phase on purpose: an operator does not
 * need to distinguish `decommissioningBlueLB` from `stoppingBlueApp` — both are
 * "removing the old containers" — and every rollback state is one "rolling back".
 */
const STATE_TO_PHASE: Record<string, DeploymentPhase> = {
  deployingGreenApp: "deploying-green",
  waitingGreenReady: "waiting-green-ready",
  initializingGreenLB: "registering-green",
  configuringFrontend: "registering-green",
  healthCheckWait: "health-check",
  openingTraffic: "switching-traffic",
  drainingBlue: "draining-blue",
  waitingForDrain: "draining-blue",
  decommissioningBlueLB: "removing-blue",
  stoppingBlueApp: "removing-blue",
  removingBlueApp: "removing-blue",
  rollbackDisableGreenTraffic: "rolling-back",
  rollbackRemoveGreenHaproxyConfig: "rolling-back",
  rollbackStoppingGreenApp: "rolling-back",
  rollbackRemovingGreenApp: "rolling-back",
  // A completed rollback is a FAILED deploy from the operator's point of view:
  // the machine tidied up after itself, but the new version did not ship.
  rollbackComplete: "failed",
  completed: "completed",
  failed: "failed",
};

/**
 * Phases at or after which traffic is already on the new containers. Past this
 * point a failure can no longer roll back — the machine's own comment calls
 * `openingTraffic` the point of no return — and the UI must not imply otherwise.
 */
const CUT_OVER_PHASES = new Set<DeploymentPhase>([
  "switching-traffic",
  "draining-blue",
  "removing-blue",
  "completed",
]);

export function phaseForState(stateValue: unknown): DeploymentPhase | null {
  if (typeof stateValue !== "string") return null;
  return STATE_TO_PHASE[stateValue] ?? null;
}

/**
 * Emit one phase transition. Never throws: progress reporting must not be able to
 * break the deployment it is reporting on.
 */
export function emitDeploymentPhase(args: {
  stackId: string;
  serviceName: string;
  phase: DeploymentPhase;
}): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_DEPLOYMENT_PHASE, {
      stackId: args.stackId,
      serviceName: args.serviceName,
      phase: args.phase,
      label: DEPLOYMENT_PHASE_LABELS[args.phase],
      cutOver: CUT_OVER_PHASES.has(args.phase),
    });
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error), ...args },
      "Failed to emit deployment phase (non-fatal)",
    );
  }
}

/**
 * Build the `onTransition` callback for `runStateMachineToCompletion`.
 *
 * De-duplicates: several machine states share a phase (three of them are
 * "removing-blue"), and re-emitting the same phase three times would render as
 * three identical steps.
 */
export function createPhaseReporter(stackId: string, serviceName: string) {
  let lastPhase: DeploymentPhase | null = null;

  return (snapshot: { value: unknown }) => {
    const phase = phaseForState(snapshot.value);
    if (!phase || phase === lastPhase) return;
    lastPhase = phase;
    emitDeploymentPhase({ stackId, serviceName, phase });
  };
}
