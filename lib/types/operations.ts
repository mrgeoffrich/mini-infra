// ====================
// Shared Operation Step Types
// ====================

export type StepStatus = 'completed' | 'failed' | 'skipped';

/**
 * A single step in a multi-step operation.
 * Used by certificate issuance, HAProxy migration, remediation, manual frontend setup,
 * self-update, and agent-sidecar startup flows.
 */
export interface OperationStep {
  step: string;
  status: StepStatus;
  detail?: string;
}
