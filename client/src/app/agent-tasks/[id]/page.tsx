import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  IconArrowLeft,
  IconLoader2,
  IconPlayerStop,
  IconRefresh,
  IconChevronDown,
  IconChevronRight,
  IconAlertCircle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  useAgentSidecarTask,
  useCancelAgentSidecarTask,
} from "@/hooks/use-agent-sidecar";
import { TaskStatusBadge } from "@/components/agent-sidecar/task-status-badge";
import { TaskStreamViewer } from "@/components/agent-sidecar/task-stream-viewer";

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export default function AgentTaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading, error, refetch } = useAgentSidecarTask(id);
  const { mutate: cancelTask, isPending: isCancelling } = useCancelAgentSidecarTask();
  const [contextExpanded, setContextExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-12 w-64" />
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {error?.message ?? "Task not found"}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const isRunning = task.status === "running";

  const handleCancel = () => {
    if (!id) return;
    cancelTask(id, {
      onSuccess: () => toast.success("Task cancelled"),
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="icon" onClick={() => navigate("/agent-tasks")}>
            <IconArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">Task</h1>
              <code className="text-sm text-muted-foreground">{task.id.slice(0, 8)}</code>
              <TaskStatusBadge status={task.status} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isRunning && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleCancel}
                disabled={isCancelling}
              >
                {isCancelling ? (
                  <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <IconPlayerStop className="h-4 w-4 mr-1" />
                )}
                Cancel
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <IconRefresh className="h-4 w-4 mr-1" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-4">
        {/* Task Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>Task Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-medium">Prompt</p>
              <p className="text-sm whitespace-pre-wrap">{task.prompt}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Triggered By</p>
                <p className="text-sm font-medium">{task.triggeredBy}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Created</p>
                <p className="text-sm font-medium">
                  {format(new Date(task.createdAt), "PPp")}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Completed</p>
                <p className="text-sm font-medium">
                  {task.completedAt ? format(new Date(task.completedAt), "PPp") : "—"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Duration</p>
                <p className="text-sm font-medium">{formatDuration(task.durationMs)}</p>
              </div>
            </div>

            {task.tokenUsage && (
              <div className="flex gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Input Tokens</p>
                  <p className="text-sm font-medium">{task.tokenUsage.input.toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Output Tokens</p>
                  <p className="text-sm font-medium">{task.tokenUsage.output.toLocaleString()}</p>
                </div>
              </div>
            )}

            {task.context && Object.keys(task.context).length > 0 && (
              <div>
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setContextExpanded(!contextExpanded)}
                >
                  {contextExpanded ? (
                    <IconChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <IconChevronRight className="h-3.5 w-3.5" />
                  )}
                  Context
                </button>
                {contextExpanded && (
                  <pre className="mt-2 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(task.context, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Live Stream / Tool Calls */}
        <Card>
          <CardHeader>
            <CardTitle>{isRunning ? "Live Stream" : "Tool Calls"}</CardTitle>
          </CardHeader>
          <CardContent>
            {isRunning ? (
              <TaskStreamViewer taskId={task.id} isRunning={true} />
            ) : task.toolCalls && task.toolCalls.length > 0 ? (
              <div className="space-y-2">
                {task.toolCalls.map((tc, i) => (
                  <ToolCallItem key={i} tool={tc.tool} input={tc.input} timestamp={tc.timestamp} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No tool calls recorded
              </p>
            )}
          </CardContent>
        </Card>

        {/* Result/Error Card */}
        {task.status === "completed" && task.result && (
          <Card>
            <CardHeader>
              <CardTitle>Result</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-wrap">{task.result}</p>
            </CardContent>
          </Card>
        )}

        {task.status === "failed" && (
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>{task.errorMessage ?? "Task failed"}</AlertDescription>
          </Alert>
        )}

        {task.status === "timeout" && (
          <Alert className="border-orange-500 bg-orange-50 text-orange-800 dark:bg-orange-900/20 dark:text-orange-300">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>Task exceeded the configured timeout limit</AlertDescription>
          </Alert>
        )}

        {task.status === "cancelled" && (
          <Alert>
            <AlertDescription>This task was cancelled</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}

function ToolCallItem({
  tool,
  input,
  timestamp,
}: {
  tool: string;
  input: Record<string, unknown>;
  timestamp: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border rounded-md p-3">
      <button
        className="flex items-center gap-2 w-full text-left text-sm"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <IconChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <IconChevronRight className="h-4 w-4 shrink-0" />
        )}
        <Badge variant="outline" className="font-mono text-xs">
          {tool}
        </Badge>
        <span className="text-xs text-muted-foreground ml-auto">
          {format(new Date(timestamp), "HH:mm:ss")}
        </span>
      </button>
      {expanded && (
        <pre className="mt-2 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}
