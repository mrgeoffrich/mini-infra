import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { PoolInstanceInfo, StackServiceInfo } from "@mini-infra/types";
import {
  IconChevronDown,
  IconChevronRight,
  IconLoader2,
  IconPlayerStop,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  usePoolInstances,
  useStopPoolInstance,
} from "@/hooks/use-pool-instances";

interface PoolServiceRowProps {
  stackId: string;
  service: StackServiceInfo;
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "running":
      return {
        label: "Running",
        className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
      };
    case "starting":
      return {
        label: "Starting",
        className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
      };
    case "stopping":
      return {
        label: "Stopping",
        className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
      };
    case "error":
      return {
        label: "Error",
        className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
      };
    default:
      return { label: status, className: "" };
  }
}

/**
 * Expandable row for a Pool-type service. Instances are managed by the
 * caller (typically another service in the stack) via the pool API; the UI
 * exposes observation + a manual stop action only.
 */
export function PoolServiceRow({ stackId, service }: PoolServiceRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [stopTarget, setStopTarget] = useState<PoolInstanceInfo | null>(null);

  const { data: instances = [], isLoading } = usePoolInstances(
    stackId,
    service.serviceName,
    expanded,
  );
  const stopMutation = useStopPoolInstance();

  const counts = useMemo(() => {
    let running = 0;
    let starting = 0;
    for (const inst of instances) {
      if (inst.status === "running") running++;
      else if (inst.status === "starting") starting++;
    }
    return { running, starting };
  }, [instances]);

  const handleStop = () => {
    if (!stopTarget) return;
    const target = stopTarget;
    setStopTarget(null);
    stopMutation.mutate(
      {
        stackId,
        serviceName: service.serviceName,
        instanceId: target.instanceId,
      },
      {
        onSuccess: () => {
          toast.success(`Stopped ${target.instanceId}`);
        },
        onError: (err) => {
          toast.error(
            `Failed to stop ${target.instanceId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      },
    );
  };

  return (
    <>
      <div className="rounded-md border">
        <button
          type="button"
          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/50 transition-colors"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-3 min-w-0">
            {expanded ? (
              <IconChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <IconChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{service.serviceName}</span>
                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300">
                  Pool
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {service.dockerImage}:{service.dockerTag}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline">
              {counts.running} running
            </Badge>
            {counts.starting > 0 && (
              <Badge variant="outline" className="text-yellow-700 dark:text-yellow-300">
                {counts.starting} starting
              </Badge>
            )}
          </div>
        </button>

        {expanded && (
          <div className="border-t p-3">
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <IconLoader2 className="h-4 w-4 animate-spin" />
                Loading instances...
              </div>
            ) : instances.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No active instances. Pool instances are created on demand by the
                caller service.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="py-2 pr-3 font-medium">Instance ID</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 pr-3 font-medium">Last Active</th>
                      <th className="py-2 pr-3 font-medium">Container</th>
                      <th className="py-2 pl-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((inst) => {
                      const badge = statusBadge(inst.status);
                      return (
                        <tr key={inst.id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-mono text-xs">
                            {inst.instanceId}
                          </td>
                          <td className="py-2 pr-3">
                            <Badge className={badge.className}>{badge.label}</Badge>
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground">
                            {formatRelative(inst.lastActive)}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                            {inst.containerId ? inst.containerId.slice(0, 12) : "—"}
                          </td>
                          <td className="py-2 pl-3 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setStopTarget(inst)}
                              disabled={
                                inst.status === "stopping" ||
                                stopMutation.isPending
                              }
                            >
                              <IconPlayerStop className="h-3.5 w-3.5" />
                              Stop
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog
        open={!!stopTarget}
        onOpenChange={(open) => !open && setStopTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop pool instance?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop and remove the container for instance{" "}
              <span className="font-mono">{stopTarget?.instanceId}</span>. The
              caller service may re-spawn it on the next triggering event.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleStop}>Stop</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
