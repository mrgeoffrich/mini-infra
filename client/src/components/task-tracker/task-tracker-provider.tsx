/**
 * Global task tracker provider.
 *
 * Maintains a map of all active/recent long-running operations, subscribes to
 * Socket.IO events at the app level so progress survives navigation, and
 * persists active tasks to sessionStorage for page-refresh recovery.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { TaskTrackerContext } from "@/lib/task-tracker-context";
import { TASK_TYPE_REGISTRY } from "@/lib/task-type-registry";
import type {
  TrackedTask,
  RegisterTaskOptions,
  PersistedTask,
  TaskTrackerContextType,
} from "@/lib/task-tracker-types";
import type { OperationState, OperationStep } from "@/hooks/use-operation-progress";
import { useSocketChannel, useSocketEvent } from "@/hooks/use-socket";
import { ServerEvent } from "@mini-infra/types";
import type { SocketChannel, ServerToClientEvents } from "@mini-infra/types";

// Dynamic event name means the handler signature cannot be inferred at
// the call site; cast through this alias rather than scattering `as any`.
type AnyServerHandler = ServerToClientEvents[keyof ServerToClientEvents];

// The union of all server-to-client event payload types.
// TaskEventListener receives config.startedEvent as keyof ServerToClientEvents (the full union),
// so TypeScript can't statically narrow to a specific event — but data IS one of these
// concrete types at runtime, so we express that rather than lying with `unknown`.
type AnyEventPayload = {
  [K in keyof ServerToClientEvents]: Parameters<ServerToClientEvents[K]>[0];
}[keyof ServerToClientEvents];

// ====================
// Constants
// ====================

const STORAGE_KEY = "mini-infra:tracked-tasks";
const MAX_PERSISTED_TASKS = 20;
const AUTO_DISMISS_MS = 5 * 60 * 1000; // 5 minutes
const RESTORE_TIMEOUT_MS = 30_000; // 30 seconds

const INITIAL_OPERATION_STATE: OperationState = {
  phase: "executing",
  totalSteps: 0,
  completedSteps: [],
  plannedStepNames: [],
  errors: [],
};

// ====================
// sessionStorage helpers
// ====================

function loadPersistedTasks(): PersistedTask[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_PERSISTED_TASKS);
  } catch {
    return [];
  }
}

function persistTasks(tasks: Map<string, TrackedTask>) {
  const executing: PersistedTask[] = [];
  for (const task of tasks.values()) {
    if (task.operationState.phase === "executing") {
      executing.push({
        id: task.id,
        type: task.type,
        label: task.label,
        channel: task.channel,
        startedAt: task.startedAt,
      });
    }
  }
  try {
    if (executing.length === 0) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(executing.slice(0, MAX_PERSISTED_TASKS)),
      );
    }
  } catch {
    // sessionStorage full or unavailable — ignore
  }
}

// ====================
// TaskEventListener — renderless component for socket subscriptions
// ====================

function TaskEventListener({
  task,
  onUpdate,
}: {
  task: TrackedTask;
  onUpdate: (id: string, updater: (prev: TrackedTask) => TrackedTask) => void;
}) {
  const queryClient = useQueryClient();
  const config = TASK_TYPE_REGISTRY[task.type];
  const isExecuting = task.operationState.phase === "executing";

  // Subscribe to the channel
  useSocketChannel(config.channel as SocketChannel, isExecuting);

  // Started event
  useSocketEvent(
    config.startedEvent,
    ((data: AnyEventPayload) => {
      if (config.getId(data) !== task.id) return;
      const { totalSteps, plannedStepNames } = config.normalizeStarted(data);
      onUpdate(task.id, (prev) => ({
        ...prev,
        operationState: {
          phase: "executing",
          totalSteps,
          completedSteps: [],
          plannedStepNames,
          errors: [],
        },
      }));
    }) as AnyServerHandler,
    isExecuting,
  );

  // Step event
  useSocketEvent(
    config.stepEvent ?? config.startedEvent, // fallback doesn't matter when disabled
    ((data: AnyEventPayload) => {
      if (!config.stepEvent || !config.normalizeStep) return;
      if (config.getId(data) !== task.id) return;
      const step = config.normalizeStep(data);
      onUpdate(task.id, (prev) => ({
        ...prev,
        operationState: {
          ...prev.operationState,
          completedSteps: [...prev.operationState.completedSteps, step],
        },
      }));
    }) as AnyServerHandler,
    isExecuting && !!config.stepEvent,
  );

  // Service-Addons render-pass step events. The render pipeline emits
  // `STACK_ADDON_PROVISIONED` / `STACK_ADDON_FAILED` once per addon
  // application during stack apply / update — distinct from the per-action
  // `STACK_APPLY_SERVICE_RESULT` step stream because addon expansion
  // happens before any service action runs. The contract calls for these
  // to surface under the same apply task in the tracker (Phase 3 of the
  // Service Addons plan), so we listen on the same channel and append
  // synthetic steps to the active task's completedSteps when the stackId
  // matches. Only stack-apply / stack-update task types subscribe.
  const isStackApplyLike =
    task.type === "stack-apply" || task.type === "stack-update";
  useSocketEvent(
    ServerEvent.STACK_ADDON_PROVISIONED as keyof ServerToClientEvents,
    ((data: AnyEventPayload) => {
      if (!isStackApplyLike) return;
      const payload = data as {
        stackId: string;
        serviceName: string;
        addonIds: string[];
        kind?: string;
        syntheticServiceName: string;
      };
      if (payload.stackId !== task.id) return;
      const label = payload.kind ?? payload.addonIds.join(", ");
      onUpdate(task.id, (prev) => ({
        ...prev,
        operationState: {
          ...prev.operationState,
          completedSteps: [
            ...prev.operationState.completedSteps,
            {
              step: `provisioned ${label} on ${payload.serviceName}`,
              status: "completed",
            },
          ],
        },
      }));
    }) as AnyServerHandler,
    isExecuting && isStackApplyLike,
  );
  useSocketEvent(
    ServerEvent.STACK_ADDON_FAILED as keyof ServerToClientEvents,
    ((data: AnyEventPayload) => {
      if (!isStackApplyLike) return;
      const payload = data as {
        stackId: string;
        serviceName: string;
        addonIds: string[];
        kind?: string;
        error: string;
      };
      if (payload.stackId !== task.id) return;
      const label = payload.kind ?? payload.addonIds.join(", ");
      onUpdate(task.id, (prev) => ({
        ...prev,
        operationState: {
          ...prev.operationState,
          completedSteps: [
            ...prev.operationState.completedSteps,
            {
              step: `${label} addon failed on ${payload.serviceName}`,
              status: "failed",
              detail: payload.error,
            },
          ],
        },
      }));
    }) as AnyServerHandler,
    isExecuting && isStackApplyLike,
  );

  const applyTerminalResult = (
    result: { success: boolean; steps: OperationStep[]; errors: string[] },
  ): void => {
    onUpdate(task.id, (prev) => {
      const phase = result.success ? "success" : "error";

      // Show toast if the originating dialog is not open
      if (!prev.dialogOpen) {
        if (result.success) {
          toast.success(`${prev.label} — completed`);
        } else {
          toast.error(`${prev.label} — failed`);
        }
      }

      return {
        ...prev,
        completedAt: Date.now(),
        operationState: {
          phase,
          totalSteps: result.steps.length || prev.operationState.totalSteps,
          completedSteps: result.steps,
          plannedStepNames: prev.operationState.plannedStepNames,
          errors: result.errors,
        },
      };
    });

    // Invalidate queries
    if (config.invalidateKeys) {
      for (const key of config.invalidateKeys(task.id)) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    }
  };

  // Completed event
  useSocketEvent(
    config.completedEvent,
    ((data: AnyEventPayload) => {
      if (config.getId(data) !== task.id) return;
      applyTerminalResult(config.normalizeCompleted(data));
    }) as AnyServerHandler,
    isExecuting,
  );

  // Optional failure event (e.g. pool-spawn splits success/failure into two
  // distinct events). When present, the failed payload feeds into the same
  // terminal-result handler so the task transitions to the error phase.
  useSocketEvent(
    config.failedEvent ?? config.completedEvent, // fallback doesn't matter when disabled
    ((data: AnyEventPayload) => {
      if (!config.failedEvent || !config.normalizeFailed) return;
      if (config.getId(data) !== task.id) return;
      applyTerminalResult(config.normalizeFailed(data));
    }) as AnyServerHandler,
    isExecuting && !!config.failedEvent,
  );

  return null;
}

// ====================
// TaskTrackerProvider
// ====================

export function TaskTrackerProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Map<string, TrackedTask>>(() => {
    // Restore persisted executing tasks on mount
    const persisted = loadPersistedTasks();
    const map = new Map<string, TrackedTask>();
    for (const p of persisted) {
      if (!TASK_TYPE_REGISTRY[p.type]) continue;
      map.set(p.id, {
        id: p.id,
        type: p.type,
        label: p.label,
        channel: p.channel,
        startedAt: p.startedAt,
        dismissed: false,
        dialogOpen: false,
        operationState: {
          ...INITIAL_OPERATION_STATE,
          totalSteps: 0,
          plannedStepNames: [],
        },
      });
    }
    return map;
  });

  // Track restored task IDs for timeout handling
  const restoredIds = useRef<Set<string>>(new Set(tasks.keys()));

  // Persist to sessionStorage whenever tasks change
  useEffect(() => {
    persistTasks(tasks);
  }, [tasks]);

  // Auto-dismiss completed tasks after timeout
  useEffect(() => {
    const completed = Array.from(tasks.values()).filter(
      (t) =>
        t.operationState.phase !== "executing" &&
        !t.dismissed &&
        t.completedAt,
    );
    if (completed.length === 0) return;

    const timers = completed.map((t) => {
      const elapsed = Date.now() - (t.completedAt ?? Date.now());
      const remaining = Math.max(0, AUTO_DISMISS_MS - elapsed);
      return setTimeout(() => {
        setTasks((prev) => {
          const next = new Map(prev);
          next.delete(t.id);
          return next;
        });
      }, remaining);
    });

    return () => timers.forEach(clearTimeout);
  }, [tasks]);

  // Timeout restored tasks that receive no events
  useEffect(() => {
    if (restoredIds.current.size === 0) return;

    const timer = setTimeout(() => {
      // Capture and clear restored IDs outside setState to avoid ref mutation in updater
      const idsToCheck = new Set(restoredIds.current);
      restoredIds.current.clear();
      setTasks((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const id of idsToCheck) {
          const task = next.get(id);
          if (task && task.operationState.phase === "executing" && task.operationState.completedSteps.length === 0) {
            changed = true;
            next.set(id, {
              ...task,
              completedAt: Date.now(),
              operationState: {
                ...task.operationState,
                phase: "error",
                errors: [
                  "Operation status unknown — the server may have restarted. Check the result manually.",
                ],
              },
            });
          }
        }
        return changed ? next : prev;
      });
    }, RESTORE_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, []); // Only run once on mount

  // Task update callback (stable reference for event listeners)
  const updateTask = useCallback(
    (id: string, updater: (prev: TrackedTask) => TrackedTask) => {
      // Clear from restored set outside setState to avoid ref mutation in updater
      restoredIds.current.delete(id);
      setTasks((prev) => {
        const task = prev.get(id);
        if (!task) return prev;
        const next = new Map(prev);
        const updated = updater(task);
        next.set(id, updated);
        return next;
      });
    },
    [],
  );

  const registerTask = useCallback((opts: RegisterTaskOptions) => {
    setTasks((prev) => {
      // Don't re-register if already executing with this ID
      const existing = prev.get(opts.id);
      if (existing && existing.operationState.phase === "executing") return prev;

      const next = new Map(prev);
      next.set(opts.id, {
        id: opts.id,
        type: opts.type,
        label: opts.label,
        channel: opts.channel,
        startedAt: Date.now(),
        dismissed: false,
        dialogOpen: false,
        operationState: {
          phase: "executing",
          totalSteps: opts.totalSteps ?? 0,
          completedSteps: [],
          plannedStepNames: opts.plannedStepNames ?? [],
          errors: [],
        },
      });
      return next;
    });
  }, []);

  const dismissTask = useCallback((id: string) => {
    setTasks((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const dismissAllCompleted = useCallback(() => {
    setTasks((prev) => {
      const next = new Map(prev);
      for (const [id, task] of next) {
        if (task.operationState.phase !== "executing") {
          next.delete(id);
        }
      }
      return next;
    });
  }, []);

  const getTask = useCallback(
    (id: string) => tasks.get(id),
    [tasks],
  );

  const setDialogOpen = useCallback((id: string, open: boolean) => {
    setTasks((prev) => {
      const task = prev.get(id);
      if (!task || task.dialogOpen === open) return prev;
      const next = new Map(prev);
      next.set(id, { ...task, dialogOpen: open });
      return next;
    });
  }, []);

  const activeTasks = useMemo(
    () =>
      Array.from(tasks.values()).filter(
        (t) => t.operationState.phase === "executing",
      ),
    [tasks],
  );

  const recentTasks = useMemo(
    () =>
      Array.from(tasks.values()).filter(
        (t) => t.operationState.phase !== "executing" && !t.dismissed,
      ),
    [tasks],
  );

  const hasActiveTasks = activeTasks.length > 0;

  const contextValue: TaskTrackerContextType = useMemo(
    () => ({
      tasks,
      registerTask,
      dismissTask,
      dismissAllCompleted,
      getTask,
      setDialogOpen,
      activeTasks,
      recentTasks,
      hasActiveTasks,
    }),
    [
      tasks,
      registerTask,
      dismissTask,
      dismissAllCompleted,
      getTask,
      setDialogOpen,
      activeTasks,
      recentTasks,
      hasActiveTasks,
    ],
  );

  // Render event listeners for all tracked tasks (not just executing) so that
  // unmounting doesn't prematurely decrement the channel ref count. The
  // isExecuting flag inside each listener gates event processing.
  const allTrackedTasks = useMemo(
    () => Array.from(tasks.values()),
    [tasks],
  );

  return (
    <TaskTrackerContext.Provider value={contextValue}>
      {allTrackedTasks.map((task) => (
        <TaskEventListener key={task.id} task={task} onUpdate={updateTask} />
      ))}
      {children}
    </TaskTrackerContext.Provider>
  );
}
