/**
 * Top-nav task tracker popover.
 *
 * Shows a badge with the count of active operations and a popover listing
 * all active and recently completed tasks. Click a task to open a detail dialog.
 */

import { useState } from "react";
import {
  IconLoader2,
  IconCheck,
  IconX,
  IconListCheck,
  IconCertificate,
  IconPlug,
  IconStack2,
  IconTrash,
  IconArrowsShuffle,
} from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import type { TrackedTask } from "@/lib/task-tracker-types";
import type { TaskType } from "@/lib/task-tracker-types";
import { TaskDetailDialog } from "./task-detail-dialog";

// ====================
// Helpers
// ====================

function getTaskIcon(type: TaskType) {
  switch (type) {
    case "cert-issuance":
      return <IconCertificate className="h-4 w-4 text-muted-foreground" />;
    case "connect-container":
      return <IconPlug className="h-4 w-4 text-muted-foreground" />;
    case "stack-apply":
      return <IconStack2 className="h-4 w-4 text-muted-foreground" />;
    case "stack-destroy":
      return <IconTrash className="h-4 w-4 text-muted-foreground" />;
    case "migration":
      return <IconArrowsShuffle className="h-4 w-4 text-muted-foreground" />;
  }
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

// ====================
// Task row components
// ====================

function ActiveTaskRow({
  task,
  onViewDetail,
}: {
  task: TrackedTask;
  onViewDetail: (task: TrackedTask) => void;
}) {
  const { completedSteps, totalSteps } = task.operationState;
  const progress = totalSteps > 0 ? `${completedSteps.length}/${totalSteps}` : "...";

  return (
    <button
      onClick={() => onViewDetail(task)}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent rounded-md text-left transition-colors cursor-pointer"
    >
      {getTaskIcon(task.type)}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{task.label}</p>
        <p className="text-xs text-muted-foreground">
          {progress} steps &middot; {formatElapsed(task.startedAt)}
        </p>
      </div>
      <IconLoader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
    </button>
  );
}

function CompletedTaskRow({
  task,
  onViewDetail,
  onDismiss,
}: {
  task: TrackedTask;
  onViewDetail: (task: TrackedTask) => void;
  onDismiss: (id: string) => void;
}) {
  const isSuccess = task.operationState.phase === "success";

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        onClick={() => onViewDetail(task)}
        className="flex-1 flex items-center gap-2 min-w-0 hover:bg-accent rounded-md transition-colors text-left cursor-pointer p-0.5"
      >
        {getTaskIcon(task.type)}
        <div className="flex-1 min-w-0">
          <p className="text-sm truncate">{task.label}</p>
        </div>
        {isSuccess ? (
          <IconCheck className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
        ) : (
          <IconX className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
        )}
      </button>
      <button
        onClick={() => onDismiss(task.id)}
        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 cursor-pointer"
        title="Dismiss"
      >
        <IconX className="h-3 w-3" />
      </button>
    </div>
  );
}

// ====================
// Main popover
// ====================

export function TaskTrackerPopover() {
  const { activeTasks, recentTasks, hasActiveTasks, dismissTask, dismissAllCompleted } =
    useTaskTracker();
  const [detailTask, setDetailTask] = useState<TrackedTask | null>(null);

  const totalVisible = activeTasks.length + recentTasks.length;
  if (totalVisible === 0) return null;

  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-1 data-[orientation=vertical]:h-4"
      />
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="relative flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            title={
              hasActiveTasks
                ? `${activeTasks.length} operation(s) running`
                : `${recentTasks.length} recent operation(s)`
            }
            data-tour="header-task-tracker"
          >
            {hasActiveTasks ? (
              <IconLoader2 className="size-5 animate-spin" />
            ) : (
              <IconListCheck className="size-5" />
            )}
            <Badge
              className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] leading-none flex items-center justify-center"
              variant={hasActiveTasks ? "default" : "secondary"}
            >
              {totalVisible}
            </Badge>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="end">
          <div className="max-h-96 overflow-y-auto">
            {/* Active operations */}
            {activeTasks.length > 0 && (
              <div className="p-2">
                <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Running
                </p>
                {activeTasks.map((task) => (
                  <ActiveTaskRow
                    key={task.id}
                    task={task}
                    onViewDetail={setDetailTask}
                  />
                ))}
              </div>
            )}

            {activeTasks.length > 0 && recentTasks.length > 0 && (
              <Separator />
            )}

            {/* Recent completed operations */}
            {recentTasks.length > 0 && (
              <div className="p-2">
                <div className="flex items-center justify-between px-3 py-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Recent
                  </p>
                  {recentTasks.length > 1 && (
                    <button
                      onClick={dismissAllCompleted}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      Dismiss all
                    </button>
                  )}
                </div>
                {recentTasks.map((task) => (
                  <CompletedTaskRow
                    key={task.id}
                    task={task}
                    onViewDetail={setDetailTask}
                    onDismiss={dismissTask}
                  />
                ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Detail dialog */}
      <TaskDetailDialog
        task={detailTask}
        onClose={() => setDetailTask(null)}
      />
    </>
  );
}
