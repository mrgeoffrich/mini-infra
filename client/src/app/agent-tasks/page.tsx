import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconRobot, IconLoader2, IconSend } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  useAgentSidecarTasks,
  useAgentSidecarStatus,
  useCreateAgentSidecarTask,
} from "@/hooks/use-agent-sidecar";
import { SidecarStatusBanner } from "@/components/agent-sidecar/sidecar-status-banner";
import { TaskStatusBadge } from "@/components/agent-sidecar/task-status-badge";

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export default function AgentTasksPage() {
  const navigate = useNavigate();
  const { data: status } = useAgentSidecarStatus();
  const { data: tasks, isLoading: tasksLoading, error: tasksError } = useAgentSidecarTasks();
  const { mutate: createTask, isPending: isCreating } = useCreateAgentSidecarTask();
  const [prompt, setPrompt] = useState("");

  const sidecarAvailable = status?.available ?? false;

  const handleSubmit = () => {
    if (!prompt.trim()) return;
    createTask(
      { prompt: prompt.trim() },
      {
        onSuccess: (task) => {
          toast.success("Task created");
          setPrompt("");
          navigate(`/agent-tasks/${task.id}`);
        },
        onError: (err) => {
          toast.error(err.message);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconRobot className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Agent Tasks</h1>
            <p className="text-muted-foreground">
              Submit and monitor AI agent tasks running in the sidecar container
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-4">
        <SidecarStatusBanner />

        {/* New Task Card */}
        <Card>
          <CardHeader>
            <CardTitle>New Task</CardTitle>
            <CardDescription>
              Describe what you want the agent to do
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              placeholder="e.g., Check the health of all running containers and report any issues..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              disabled={!sidecarAvailable || isCreating}
            />
            <Button
              onClick={handleSubmit}
              disabled={!prompt.trim() || !sidecarAvailable || isCreating}
            >
              {isCreating ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconSend className="h-4 w-4 mr-2" />
              )}
              Submit Task
            </Button>
          </CardContent>
        </Card>

        {/* Recent Tasks Card */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Tasks</CardTitle>
          </CardHeader>
          <CardContent>
            {tasksLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : tasksError ? (
              <Alert variant="destructive">
                <AlertDescription>Failed to load tasks: {tasksError.message}</AlertDescription>
              </Alert>
            ) : !tasks || tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No tasks yet. Submit a task above to get started.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Prompt</th>
                      <th className="pb-2 pr-4 font-medium w-28">Status</th>
                      <th className="pb-2 pr-4 font-medium w-36">Created</th>
                      <th className="pb-2 font-medium w-24">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr
                        key={task.id}
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => navigate(`/agent-tasks/${task.id}`)}
                      >
                        <td className="py-3 pr-4">
                          <span className="line-clamp-1">{task.prompt}</span>
                        </td>
                        <td className="py-3 pr-4">
                          <TaskStatusBadge status={task.status} />
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
                        </td>
                        <td className="py-3 text-muted-foreground">
                          {formatDuration(task.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
