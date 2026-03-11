import { IconCheck, IconAlertTriangle, IconX } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAgentSidecarStatus } from "@/hooks/use-agent-sidecar";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";

export function SidecarStatusBanner() {
  const { data: status, isLoading, error } = useAgentSidecarStatus();

  if (isLoading) {
    return <Skeleton className="h-12 w-full" />;
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <IconX className="h-4 w-4" />
        <AlertDescription>Failed to check sidecar status: {error.message}</AlertDescription>
      </Alert>
    );
  }

  if (!status) return null;

  if (status.available && status.health?.status === "ok") {
    return (
      <Alert className="border-green-500 bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300 [&>svg]:text-green-600">
        <IconCheck className="h-4 w-4" />
        <AlertDescription>
          Agent sidecar is running
          {status.health.activeTasks > 0 && (
            <> &mdash; {status.health.activeTasks} active task{status.health.activeTasks !== 1 ? "s" : ""}</>
          )}
          {status.health.totalTasksProcessed > 0 && (
            <> &middot; {status.health.totalTasksProcessed} total processed</>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (status.containerRunning) {
    return (
      <Alert className="border-yellow-500 bg-yellow-50 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300 [&>svg]:text-yellow-600">
        <IconAlertTriangle className="h-4 w-4" />
        <AlertDescription>
          Agent sidecar container is running but not healthy. It may still be starting up.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <IconX className="h-4 w-4" />
      <AlertDescription>
        Agent sidecar is not available.{" "}
        <Link to="/settings-agent-sidecar" className="underline font-medium">
          Configure in Settings
        </Link>
      </AlertDescription>
    </Alert>
  );
}
