import {
  Channel,
  ServerEvent,
  type ServiceApplyResult,
  type ResourceResult,
  type ApplyResult,
  type DestroyResult,
} from '@mini-infra/types';
import { emitToChannel } from '../../lib/socket';

/**
 * Typed wrappers around `emitToChannel` for stack operation lifecycle events.
 * Every emit is wrapped in try/catch — a socket failure must never break the
 * underlying operation.
 */

export type StackApplyStartedPayload = {
  stackId: string;
  stackName: string;
  totalActions: number;
  actions: Array<{ serviceName: string; action: string }>;
  forcePull: boolean;
};

export function emitStackApplyStarted(payload: StackApplyStartedPayload): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_STARTED, payload);
  } catch { /* never break the caller */ }
}

export function emitStackApplyServiceResult(
  stackId: string,
  result: ServiceApplyResult | ResourceResult,
  completedCount: number,
  totalActions: number,
): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_SERVICE_RESULT, {
      stackId,
      ...result,
      completedCount,
      totalActions,
    } as (ServiceApplyResult | ResourceResult) & { stackId: string; completedCount: number; totalActions: number });
  } catch { /* never break the caller */ }
}

export type StackApplyCompletedPayload = ApplyResult & {
  error?: string;
  postApply?: { success: boolean; errors?: string[] };
};

export function emitStackApplyCompleted(payload: StackApplyCompletedPayload): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, payload);
  } catch { /* never break the caller */ }
}

/** Emits a synthetic STACK_APPLY_COMPLETED with success=false for catch blocks. */
export function emitStackApplyFailed(stackId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  emitStackApplyCompleted({
    success: false,
    stackId,
    appliedVersion: 0,
    serviceResults: [],
    resourceResults: [],
    duration: 0,
    error: message,
  });
}

export function emitStackDestroyStarted(stackId: string, stackName: string): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_STARTED, { stackId, stackName });
  } catch { /* never break the caller */ }
}

export function emitStackDestroyCompleted(payload: DestroyResult): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_COMPLETED, payload);
  } catch { /* never break the caller */ }
}

export function emitStackDestroyFailed(stackId: string, error: unknown, startTime: number): void {
  const message = error instanceof Error ? error.message : String(error);
  emitStackDestroyCompleted({
    success: false,
    stackId,
    containersRemoved: 0,
    networksRemoved: [],
    volumesRemoved: [],
    duration: Date.now() - startTime,
    error: message,
  });
}

export type StackAddonProvisionedPayload = {
  stackId: string;
  serviceName: string;
  addonIds: string[];
  kind?: string;
  syntheticServiceName: string;
};

export function emitStackAddonProvisioned(
  payload: StackAddonProvisionedPayload,
): void {
  try {
    emitToChannel(
      Channel.STACKS,
      ServerEvent.STACK_ADDON_PROVISIONED,
      payload,
    );
  } catch { /* never break the caller */ }
}

export type StackAddonFailedPayload = {
  stackId: string;
  serviceName: string;
  addonIds: string[];
  kind?: string;
  error: string;
};

export function emitStackAddonFailed(payload: StackAddonFailedPayload): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_ADDON_FAILED, payload);
  } catch { /* never break the caller */ }
}
