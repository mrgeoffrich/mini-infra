/**
 * Static registry mapping TaskType → Socket.IO event configuration and normalizers.
 *
 * Each entry is built with defineTaskTypeConfig(), which infers the three event-key
 * generics so TypeScript validates every normalizer against the actual event payload
 * shape. The registry itself is typed as Record<TaskType, RuntimeTaskTypeConfig>,
 * which erases those generics for polymorphic access in TaskEventListener.
 */

import { Channel, ServerEvent } from "@mini-infra/types";
import type { SocketChannel, ServerToClientEvents } from "@mini-infra/types";
import type { OperationStep } from "@/hooks/use-operation-progress";
import type { TaskType } from "./task-tracker-types";

// ====================
// Type Helpers
// ====================

/** Extract the data payload type for a specific server-to-client event. */
type EventPayload<K extends keyof ServerToClientEvents> =
  Parameters<ServerToClientEvents[K]>[0];

/** Maps a step-event key to its normalizer function, or null when there is no step event. */
type NormalizeStepFn<TStep extends keyof ServerToClientEvents | null> =
  TStep extends keyof ServerToClientEvents
    ? (payload: EventPayload<TStep>) => OperationStep
    : null;

// ====================
// Generic TaskTypeConfig
// ====================

/**
 * Type-safe config for a single task type.
 *
 * The three event-key generics ensure that each normalizer is validated against
 * the actual payload shape of its event at definition time. Entries are created
 * via defineTaskTypeConfig() so TypeScript infers the generics automatically.
 */
export interface TaskTypeConfig<
  TStarted extends keyof ServerToClientEvents,
  TStep extends keyof ServerToClientEvents | null,
  TCompleted extends keyof ServerToClientEvents,
> {
  channel: SocketChannel;
  startedEvent: TStarted;
  /** null for task types that emit no intermediate step events */
  stepEvent: TStep;
  completedEvent: TCompleted;
  /** Extract the task ID from a started-event payload */
  getId: (payload: EventPayload<TStarted>) => string;
  /** Normalize "started" payload */
  normalizeStarted: (payload: EventPayload<TStarted>) => {
    totalSteps: number;
    plannedStepNames: string[];
  };
  /** Normalize "step" payload → OperationStep (null when stepEvent is null) */
  normalizeStep: NormalizeStepFn<TStep>;
  /** Normalize "completed" payload */
  normalizeCompleted: (payload: EventPayload<TCompleted>) => {
    success: boolean;
    steps: OperationStep[];
    errors: string[];
  };
  /** Query keys to invalidate on completion */
  invalidateKeys?: (taskId: string) => unknown[][];
}

/**
 * Builder that infers the three event-key generics from the config literal,
 * so TypeScript validates each normalizer against the real event payload shape.
 */
function defineTaskTypeConfig<
  TStarted extends keyof ServerToClientEvents,
  TStep extends keyof ServerToClientEvents | null,
  TCompleted extends keyof ServerToClientEvents,
>(
  config: TaskTypeConfig<TStarted, TStep, TCompleted>,
): TaskTypeConfig<TStarted, TStep, TCompleted> {
  return config;
}

// ====================
// RuntimeTaskTypeConfig — erased type for polymorphic access
// ====================

/**
 * Erased config type for runtime polymorphic access in TaskEventListener.
 *
 * TaskEventListener receives a config via TASK_TYPE_REGISTRY[task.type] where
 * task.type is the TaskType union, losing the specific event-key generics.
 * TypeScript's contravariant function-parameter rule prevents assigning
 * `(p: SpecificPayload) => R` to `(p: WidenedPayload) => R`, so the normalizer
 * payload parameters are `any` here.
 *
 * This is a deliberate, documented variance boundary — each entry is still
 * validated at definition time via defineTaskTypeConfig().
 */
export interface RuntimeTaskTypeConfig {
  channel: SocketChannel;
  startedEvent: keyof ServerToClientEvents;
  stepEvent: keyof ServerToClientEvents | null;
  completedEvent: keyof ServerToClientEvents;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getId: (payload: any) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalizeStarted: (payload: any) => { totalSteps: number; plannedStepNames: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalizeStep: ((payload: any) => OperationStep) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalizeCompleted: (payload: any) => { success: boolean; steps: OperationStep[]; errors: string[] };
  invalidateKeys?: (taskId: string) => unknown[][];
}

// ====================
// Registry
// ====================

export const TASK_TYPE_REGISTRY: Record<TaskType, RuntimeTaskTypeConfig> = {
  "cert-issuance": defineTaskTypeConfig({
    channel: Channel.TLS,
    startedEvent: ServerEvent.CERT_ISSUANCE_STARTED,
    stepEvent: ServerEvent.CERT_ISSUANCE_STEP,
    completedEvent: ServerEvent.CERT_ISSUANCE_COMPLETED,
    getId: (p) => p.operationId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalSteps,
      plannedStepNames: p.stepNames ?? [],
    }),
    normalizeStep: (p) => p.step,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.steps,
      errors: p.errors,
    }),
    invalidateKeys: () => [["certificates"]],
  }),

  "connect-container": defineTaskTypeConfig({
    channel: Channel.HAPROXY,
    startedEvent: ServerEvent.FRONTEND_SETUP_STARTED,
    stepEvent: ServerEvent.FRONTEND_SETUP_STEP,
    completedEvent: ServerEvent.FRONTEND_SETUP_COMPLETED,
    getId: (p) => p.operationId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalSteps,
      plannedStepNames: p.stepNames ?? [],
    }),
    normalizeStep: (p) => p.step,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.steps,
      errors: p.errors,
    }),
    invalidateKeys: () => [
      ["haproxy-frontends"],
      ["haproxy-backends"],
      ["containers"],
    ],
  }),

  "stack-apply": defineTaskTypeConfig({
    channel: Channel.STACKS,
    startedEvent: ServerEvent.STACK_APPLY_STARTED,
    stepEvent: ServerEvent.STACK_APPLY_SERVICE_RESULT,
    completedEvent: ServerEvent.STACK_APPLY_COMPLETED,
    getId: (p) => p.stackId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalActions,
      plannedStepNames: p.actions.map((a) => `${a.action} ${a.serviceName}`),
    }),
    normalizeStep: (p) => {
      // step:apply:service-result carries either a ServiceApplyResult or ResourceResult
      if ('resourceType' in p) {
        return {
          step: `${p.action} ${p.resourceType}:${p.resourceName}`,
          status: p.success ? "completed" : "failed",
          detail: p.error ?? undefined,
        };
      }
      return {
        step: `${p.action} ${p.serviceName}`,
        status: p.success ? "completed" : "failed",
        detail: p.error ?? undefined,
      };
    },
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: [
        ...p.serviceResults.map((r) => ({
          step: `${r.action} ${r.serviceName}`,
          status: r.success ? "completed" as const : "failed" as const,
          detail: r.error ?? undefined,
        })),
        ...p.resourceResults
          .filter((r) => r.action !== "no-op")
          .map((r) => ({
            step: `${r.action} ${r.resourceType}:${r.resourceName}`,
            status: r.success ? "completed" as const : "failed" as const,
            detail: r.error ?? undefined,
          })),
      ],
      errors: [
        ...(p.error ? [p.error] : []),
        ...(p.postApply?.errors ?? []),
      ],
    }),
    invalidateKeys: (taskId) => [
      ["stacks"],
      ["stack", taskId],
      ["stackPlan", taskId],
      ["stackStatus", taskId],
      ["stackHistory", taskId],
      ["applications"],
      ["userStacks"],
    ],
  }),

  "stack-update": defineTaskTypeConfig({
    channel: Channel.STACKS,
    startedEvent: ServerEvent.STACK_APPLY_STARTED,
    stepEvent: ServerEvent.STACK_APPLY_SERVICE_RESULT,
    completedEvent: ServerEvent.STACK_APPLY_COMPLETED,
    getId: (p) => p.stackId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalActions,
      plannedStepNames: p.actions.map((a) => `update ${a.serviceName}`),
    }),
    normalizeStep: (p) => {
      if ('resourceType' in p) {
        return {
          step: `update ${p.resourceType}:${p.resourceName}`,
          status: p.success ? "completed" : "failed",
          detail: p.error ?? undefined,
        };
      }
      return {
        step: `update ${p.serviceName}`,
        status: p.success ? "completed" : "failed",
        detail: p.error ?? undefined,
      };
    },
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.serviceResults.map((r) => ({
        step: `update ${r.serviceName}`,
        status: r.success ? "completed" as const : "failed" as const,
        detail: r.error ?? undefined,
      })),
      errors: [
        ...(p.error ? [p.error] : []),
        ...(p.postApply?.errors ?? []),
      ],
    }),
    invalidateKeys: (taskId) => [
      ["stacks"],
      ["stack", taskId],
      ["stackPlan", taskId],
      ["stackStatus", taskId],
      ["stackHistory", taskId],
      ["applications"],
      ["userStacks"],
    ],
  }),

  "stack-destroy": defineTaskTypeConfig({
    channel: Channel.STACKS,
    startedEvent: ServerEvent.STACK_DESTROY_STARTED,
    stepEvent: null,
    completedEvent: ServerEvent.STACK_DESTROY_COMPLETED,
    getId: (p) => p.stackId,
    normalizeStarted: () => ({
      totalSteps: 1,
      plannedStepNames: ["Destroy stack"],
    }),
    normalizeStep: null,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: [
        {
          step: "Destroy stack",
          status: p.success ? "completed" : "failed",
          detail: p.success
            ? `Removed ${p.containersRemoved} container(s), ${p.networksRemoved?.length ?? 0} network(s), ${p.volumesRemoved?.length ?? 0} volume(s)`
            : p.error ?? undefined,
        },
      ],
      errors: p.error ? [p.error] : [],
    }),
    invalidateKeys: (taskId) => [
      ["stacks"],
      ["stack", taskId],
      ["stackPlan", taskId],
      ["stackStatus", taskId],
      ["stackHistory", taskId],
      ["applications"],
      ["userStacks"],
    ],
  }),

  migration: defineTaskTypeConfig({
    channel: Channel.STACKS,
    startedEvent: ServerEvent.MIGRATION_STARTED,
    stepEvent: ServerEvent.MIGRATION_STEP,
    completedEvent: ServerEvent.MIGRATION_COMPLETED,
    getId: (p) => p.environmentId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalSteps,
      plannedStepNames: [],
    }),
    normalizeStep: (p) => p.step,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.steps.map((s) => ({
        step: s.step,
        status: s.status,
        detail: s.detail,
      })),
      errors: p.errors ?? [],
    }),
    invalidateKeys: (taskId) => [
      ["haproxy-status", taskId],
      ["migration-preview", taskId],
      ["remediation-preview", taskId],
      ["haproxy-frontends"],
      ["stacks"],
    ],
  }),

  "sidecar-startup": defineTaskTypeConfig({
    channel: Channel.AGENT_SIDECAR,
    startedEvent: ServerEvent.SIDECAR_STARTUP_STARTED,
    stepEvent: ServerEvent.SIDECAR_STARTUP_STEP,
    completedEvent: ServerEvent.SIDECAR_STARTUP_COMPLETED,
    getId: (p) => p.operationId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalSteps,
      plannedStepNames: p.stepNames ?? [],
    }),
    normalizeStep: (p) => p.step,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.steps.map((s) => ({
        step: s.step,
        status: s.status,
        detail: s.detail,
      })),
      errors: p.errors,
    }),
    invalidateKeys: () => [
      ["agent-sidecar", "status"],
      ["agent", "status"],
    ],
  }),

  "self-update-launch": defineTaskTypeConfig({
    channel: Channel.SELF_UPDATE,
    startedEvent: ServerEvent.SELF_UPDATE_LAUNCH_STARTED,
    stepEvent: ServerEvent.SELF_UPDATE_LAUNCH_STEP,
    completedEvent: ServerEvent.SELF_UPDATE_LAUNCH_COMPLETED,
    getId: (p) => p.operationId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalSteps,
      plannedStepNames: p.stepNames ?? [],
    }),
    normalizeStep: (p) => p.step,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.steps.map((s) => ({
        step: s.step,
        status: s.status,
        detail: s.detail,
      })),
      errors: p.errors,
    }),
    invalidateKeys: () => [["self-update-status"]],
  }),

  "vault-bootstrap": defineTaskTypeConfig({
    channel: Channel.VAULT,
    startedEvent: ServerEvent.VAULT_BOOTSTRAP_STARTED,
    stepEvent: ServerEvent.VAULT_BOOTSTRAP_STEP,
    completedEvent: ServerEvent.VAULT_BOOTSTRAP_COMPLETED,
    getId: (p) => p.operationId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalSteps,
      plannedStepNames: p.stepNames ?? [],
    }),
    normalizeStep: (p) => p.step,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.steps.map((s) => ({
        step: s.step,
        status: s.status,
        detail: s.detail,
      })),
      errors: p.errors,
    }),
    invalidateKeys: () => [["vault", "status"]],
  }),

  "vault-unseal": defineTaskTypeConfig({
    channel: Channel.VAULT,
    startedEvent: ServerEvent.VAULT_UNSEAL_STARTED,
    stepEvent: ServerEvent.VAULT_UNSEAL_STEP,
    completedEvent: ServerEvent.VAULT_UNSEAL_COMPLETED,
    getId: (p) => p.operationId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalSteps,
      plannedStepNames: p.stepNames ?? [],
    }),
    normalizeStep: (p) => p.step,
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: p.steps.map((s) => ({
        step: s.step,
        status: s.status,
        detail: s.detail,
      })),
      errors: p.errors,
    }),
    invalidateKeys: () => [["vault", "status"]],
  }),
};
