/**
 * Static registry mapping TaskType → Socket.IO event configuration and normalizers.
 *
 * Each entry defines how to subscribe to and normalize events for a specific
 * operation type. This avoids serializing functions into sessionStorage —
 * on restore, look up the type string in this registry.
 */

import { Channel, ServerEvent } from "@mini-infra/types";
import type { SocketChannel, ServerToClientEvents } from "@mini-infra/types";
import type { OperationStep } from "@/hooks/use-operation-progress";
import type { TaskType } from "./task-tracker-types";

export interface TaskTypeConfig {
  channel: SocketChannel;
  startedEvent: keyof ServerToClientEvents;
  stepEvent: keyof ServerToClientEvents | null;
  completedEvent: keyof ServerToClientEvents;
  /** Extract the task ID from any event payload */
  getId: (payload: any) => string;
  /** Normalize "started" payload */
  normalizeStarted: (payload: any) => {
    totalSteps: number;
    plannedStepNames: string[];
  };
  /** Normalize "step" payload → OperationStep (null if no step event) */
  normalizeStep: ((payload: any) => OperationStep) | null;
  /** Normalize "completed" payload */
  normalizeCompleted: (payload: any) => {
    success: boolean;
    steps: OperationStep[];
    errors: string[];
  };
  /** Query keys to invalidate on completion */
  invalidateKeys?: (taskId: string) => unknown[][];
}

export const TASK_TYPE_REGISTRY: Record<TaskType, TaskTypeConfig> = {
  "cert-issuance": {
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
  },

  "connect-container": {
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
  },

  "stack-apply": {
    channel: Channel.STACKS,
    startedEvent: ServerEvent.STACK_APPLY_STARTED,
    stepEvent: ServerEvent.STACK_APPLY_SERVICE_RESULT,
    completedEvent: ServerEvent.STACK_APPLY_COMPLETED,
    getId: (p) => p.stackId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalActions,
      plannedStepNames: (p.actions as Array<{ serviceName: string; action: string }>).map(
        (a) => `${a.action} ${a.serviceName}`,
      ),
    }),
    normalizeStep: (p) => ({
      step: `${p.action} ${p.serviceName}`,
      status: p.success ? "completed" : "failed",
      detail: p.error ?? undefined,
    }),
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: (p.serviceResults as Array<{ serviceName: string; action: string; success: boolean; error?: string }>).map(
        (r) => ({
          step: `${r.action} ${r.serviceName}`,
          status: (r.success ? "completed" : "failed") as OperationStep["status"],
          detail: r.error ?? undefined,
        }),
      ),
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
    ],
  },

  "stack-destroy": {
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
          status: (p.success ? "completed" : "failed") as OperationStep["status"],
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
    ],
  },

  migration: {
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
      steps: (p.steps as Array<{ step: string; status: string; detail?: string }>).map((s) => ({
        step: s.step,
        status: s.status as OperationStep["status"],
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
  },
};
