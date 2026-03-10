/**
 * Generic hook for tracking async operation progress via Socket.IO.
 *
 * Provides a reusable pattern for the preview → executing → result state machine
 * used by both Connect Container and TLS Certificate Issuance flows.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ServerToClientEvents, SocketChannel } from "@mini-infra/types";
import { useSocketChannel, useSocketEvent } from "./use-socket";

export interface OperationStep {
  step: string;
  status: "completed" | "failed" | "skipped";
  detail?: string;
}

export type OperationPhase = "idle" | "executing" | "success" | "error";

export interface OperationState {
  phase: OperationPhase;
  totalSteps: number;
  completedSteps: OperationStep[];
  /** Names of all planned steps (sent by server at start) */
  plannedStepNames: string[];
  errors: string[];
}

const INITIAL_STATE: OperationState = {
  phase: "idle",
  totalSteps: 0,
  completedSteps: [],
  plannedStepNames: [],
  errors: [],
};

export interface UseOperationProgressOptions<
  TStarted extends keyof ServerToClientEvents,
  TStep extends keyof ServerToClientEvents,
  TCompleted extends keyof ServerToClientEvents,
> {
  /** Socket channel to subscribe to */
  channel: SocketChannel;
  /** Event names for started/step/completed */
  startedEvent: TStarted;
  stepEvent: TStep;
  completedEvent: TCompleted;
  /** Filter events by operationId — only handle events matching this ID */
  operationId: string | null;
  /** Extract operationId from event payload */
  getOperationId: (payload: any) => string;
  /** Extract totalSteps from started event */
  getTotalSteps: (payload: any) => number;
  /** Extract planned step names from started event (optional) */
  getStepNames?: (payload: any) => string[];
  /** Extract step from step event */
  getStep: (payload: any) => OperationStep;
  /** Extract result from completed event */
  getResult: (payload: any) => { success: boolean; steps: OperationStep[]; errors: string[] };
  /** TanStack Query keys to invalidate on completion */
  invalidateKeys?: unknown[][];
  /** Toast messages */
  toasts?: {
    success?: string;
    error?: string;
  };
  /** Timeout in ms before transitioning to error (default: 5 minutes) */
  timeoutMs?: number;
}

export interface UseOperationProgressReturn {
  state: OperationState;
  reset: () => void;
  isExecuting: boolean;
}

export function useOperationProgress<
  TStarted extends keyof ServerToClientEvents,
  TStep extends keyof ServerToClientEvents,
  TCompleted extends keyof ServerToClientEvents,
>(options: UseOperationProgressOptions<TStarted, TStep, TCompleted>): UseOperationProgressReturn {
  const {
    channel,
    startedEvent,
    stepEvent,
    completedEvent,
    operationId,
    getOperationId,
    getTotalSteps,
    getStepNames,
    getStep,
    getResult,
    invalidateKeys,
    toasts,
    timeoutMs = 5 * 60 * 1000,
  } = options;

  const queryClient = useQueryClient();
  const [state, setState] = useState<OperationState>(INITIAL_STATE);

  const enabled = !!operationId;

  // Subscribe to the channel eagerly (not gated on operationId) so we're
  // already listening when the server starts emitting events immediately
  // after the POST response. Event handlers filter by operationId, so
  // no spurious events are processed.
  useSocketChannel(channel);

  // Started event
  useSocketEvent(
    startedEvent,
    ((data: any) => {
      if (getOperationId(data) !== operationId) return;
      setState({
        phase: "executing",
        totalSteps: getTotalSteps(data),
        completedSteps: [],
        plannedStepNames: getStepNames?.(data) ?? [],
        errors: [],
      });
    }) as ServerToClientEvents[TStarted],
    enabled,
  );

  // Step event
  useSocketEvent(
    stepEvent,
    ((data: any) => {
      if (getOperationId(data) !== operationId) return;
      setState((prev) => ({
        ...prev,
        completedSteps: [...prev.completedSteps, getStep(data)],
      }));
    }) as ServerToClientEvents[TStep],
    enabled,
  );

  // Completed event
  useSocketEvent(
    completedEvent,
    ((data: any) => {
      if (getOperationId(data) !== operationId) return;
      const result = getResult(data);
      setState((prev) => ({
        phase: result.success ? "success" : "error",
        totalSteps: result.steps.length,
        completedSteps: result.steps,
        plannedStepNames: prev.plannedStepNames,
        errors: result.errors,
      }));

      // Invalidate queries
      if (invalidateKeys) {
        for (const key of invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }

      // Show toasts
      if (result.success && toasts?.success) {
        toast.success(toasts.success);
      } else if (!result.success && toasts?.error) {
        toast.error(toasts.error);
      }
    }) as ServerToClientEvents[TCompleted],
    enabled,
  );

  // Timeout: transition to error if completed event is never received
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (enabled && state.phase === "executing") {
      timeoutRef.current = setTimeout(() => {
        setState((prev) =>
          prev.phase === "executing"
            ? { ...prev, phase: "error", errors: ["Operation timed out — the server may still be processing. Refresh the page to check the result."] }
            : prev,
        );
      }, timeoutMs);
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [enabled, state.phase, timeoutMs]);

  const reset = useCallback(() => setState(INITIAL_STATE), []);

  return {
    state,
    reset,
    isExecuting: state.phase === "executing",
  };
}
