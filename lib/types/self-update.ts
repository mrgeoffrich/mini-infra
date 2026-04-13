// ====================
// Self-Update Types
// ====================

export type SelfUpdateState =
  | "idle"
  | "pending"
  | "checking"
  | "pulling"
  | "inspecting"
  | "stopping"
  | "creating"
  | "health-checking"
  | "complete"
  | "rolling-back"
  | "rollback-complete"
  | "failed";

export interface SelfUpdateStatus {
  state: SelfUpdateState;
  targetTag?: string;
  progress?: number;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface SelfUpdateCheckResult {
  success: boolean;
  available: boolean;
  reason?: string;
  containerId?: string;
}
