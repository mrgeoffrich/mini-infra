import {
  Channel,
  ServerEvent,
  type ServiceApplyResult,
  type ResourceResult,
  type ApplyResult,
  type DestroyResult,
  type StackStopResult,
  type StackStatus,
} from '@mini-infra/types';
import { emitToChannel } from '../../lib/socket';
import prisma from '../../lib/prisma';

/**
 * Typed wrappers around `emitToChannel` for stack operation lifecycle events.
 * Every emit is wrapped in try/catch — a socket failure must never break the
 * underlying operation.
 */

/**
 * Push a stack's persisted status change to the `stacks` channel so every open
 * list/detail view can invalidate its query without polling. Fire-and-forget:
 * it resolves the stack's scope hints (environment / template / source) with a
 * best-effort read so listeners can target the right query keys, and swallows
 * any failure — a socket or DB hiccup must never break the status write that
 * triggered it. Call it *after* the `Stack.status` write commits.
 */
export function emitStackStatusChanged(stackId: string, status: StackStatus): void {
  void (async () => {
    try {
      const stack = await prisma.stack.findUnique({
        where: { id: stackId },
        select: {
          environmentId: true,
          templateId: true,
          template: { select: { source: true } },
        },
      });
      emitToChannel(Channel.STACKS, ServerEvent.STACK_STATUS, {
        stackId,
        status,
        environmentId: stack?.environmentId ?? null,
        templateId: stack?.templateId ?? null,
        templateSource: (stack?.template?.source as 'system' | 'user' | undefined) ?? null,
      });
    } catch {
      /* never break the caller */
    }
  })();
}

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

export function emitStackStopStarted(stackId: string, stackName: string): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_STOP_STARTED, { stackId, stackName });
  } catch { /* never break the caller */ }
}

export function emitStackStopCompleted(payload: StackStopResult): void {
  try {
    emitToChannel(Channel.STACKS, ServerEvent.STACK_STOP_COMPLETED, payload);
  } catch { /* never break the caller */ }
}

/** Emits a synthetic STACK_STOP_COMPLETED with success=false for catch blocks. */
export function emitStackStopFailed(stackId: string, error: unknown, startTime: number): void {
  const message = error instanceof Error ? error.message : String(error);
  emitStackStopCompleted({
    success: false,
    stackId,
    stoppedContainers: 0,
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
