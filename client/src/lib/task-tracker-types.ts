/**
 * Types for the global background task tracker.
 *
 * Tracks long-running Socket.IO operations (cert issuance, connect container,
 * stack apply/destroy, HAProxy migration) in a global context so progress
 * persists across navigation and dialog close/open cycles.
 */

import type { OperationState } from "@/hooks/use-operation-progress";

export type TaskType =
  | "cert-issuance"
  | "connect-container"
  | "stack-apply"
  | "stack-destroy"
  | "stack-update"
  | "migration"
  | "sidecar-startup"
  | "self-update-launch"
  | "vault-bootstrap"
  | "vault-unseal";

export interface TrackedTask {
  /** Unique identifier — operationId, stackId, or environmentId */
  id: string;
  type: TaskType;
  /** Human-readable label, e.g. "Issuing cert for example.com" */
  label: string;
  /** Socket.IO channel to subscribe to */
  channel: string;
  startedAt: number;
  completedAt?: number;
  dismissed: boolean;
  /** Whether the originating dialog is currently open */
  dialogOpen: boolean;
  /** Normalized progress state */
  operationState: OperationState;
}

export interface RegisterTaskOptions {
  id: string;
  type: TaskType;
  label: string;
  channel: string;
  plannedStepNames?: string[];
  totalSteps?: number;
}

export interface TaskTrackerContextType {
  tasks: Map<string, TrackedTask>;
  registerTask: (opts: RegisterTaskOptions) => void;
  dismissTask: (id: string) => void;
  dismissAllCompleted: () => void;
  getTask: (id: string) => TrackedTask | undefined;
  setDialogOpen: (id: string, open: boolean) => void;
  activeTasks: TrackedTask[];
  recentTasks: TrackedTask[];
  hasActiveTasks: boolean;
}

/** Serializable subset persisted to sessionStorage */
export interface PersistedTask {
  id: string;
  type: TaskType;
  label: string;
  channel: string;
  startedAt: number;
}
