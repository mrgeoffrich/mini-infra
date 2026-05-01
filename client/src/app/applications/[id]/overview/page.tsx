import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  IconAlertTriangle,
  IconExternalLink,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import {
  useDeleteApplication,
  useDeployApplication,
  useStopApplication,
} from "@/hooks/use-applications";
import { useStackHistory } from "@/hooks/use-stacks";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import type { StackDeploymentRecord } from "@mini-infra/types";
import { StatusStrip } from "../_components/status-strip";
import type { ApplicationDetailContext } from "../layout";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  return `${min}m ${remSec}s`;
}

function ActivityRow({ entry }: { entry: StackDeploymentRecord }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant={entry.success ? "default" : "destructive"}>
          {entry.action}
        </Badge>
        {entry.version != null && (
          <span className="text-muted-foreground text-xs">v{entry.version}</span>
        )}
        <span className="truncate">
          {entry.success ? "succeeded" : (entry.error ?? "failed")}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
        <span>{formatDuration(entry.duration)}</span>
        <span>{formatDateTime(entry.createdAt)}</span>
      </div>
    </li>
  );
}

export default function ApplicationOverviewTab() {
  const navigate = useNavigate();
  const { template, primaryStack, containerStatus, environment, url, stacks } =
    useOutletContext<ApplicationDetailContext>();
  const { registerTask } = useTaskTracker();
  const deployApplication = useDeployApplication();
  const stopApplication = useStopApplication();
  const deleteApplication = useDeleteApplication();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: historyData } = useStackHistory(primaryStack?.id ?? "");
  const recent = (historyData?.data ?? []).slice(0, 5);

  const hasStacks = stacks.length > 0;
  const isDeploying = primaryStack?.status === "pending";
  const lastFailure = primaryStack?.lastFailureReason ?? null;

  const handleDeploy = async () => {
    if (!template.environmentId) return;
    try {
      await deployApplication.mutateAsync({
        templateId: template.id,
        name: template.name,
        environmentId: template.environmentId,
        onStackCreated: (stackId) => {
          registerTask({
            id: stackId,
            type: "stack-apply",
            label: `Deploying ${template.displayName ?? template.name}`,
            channel: Channel.STACKS,
          });
        },
      });
    } catch {
      // toast handled by mutation
    }
  };

  const handleStop = async () => {
    if (!hasStacks) return;
    try {
      for (const stack of stacks) {
        registerTask({
          id: stack.id,
          type: "stack-destroy",
          label: `Stopping ${template.displayName ?? template.name}`,
          channel: Channel.STACKS,
        });
      }
      await Promise.all(
        stacks.map((s) => stopApplication.mutateAsync(s.id)),
      );
    } catch {
      // toast handled by mutation
    }
  };

  const handleDelete = async () => {
    try {
      await deleteApplication.mutateAsync({ templateId: template.id });
      navigate("/applications");
    } finally {
      setConfirmDelete(false);
    }
  };

  return (
    <div className="grid gap-6 max-w-4xl">
      <StatusStrip stack={primaryStack} containerStatus={containerStatus} />

      {lastFailure && (
        <Alert variant="destructive">
          <IconAlertTriangle className="h-4 w-4" />
          <AlertTitle>Last apply failed</AlertTitle>
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {lastFailure}
          </AlertDescription>
        </Alert>
      )}

      {!hasStacks && (
        <Card>
          <CardHeader>
            <CardTitle>Not deployed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {template.environmentId
                ? "This application is configured but has not been deployed yet."
                : "Bind this application to an environment before deploying."}
            </p>
            {template.environmentId && (
              <Button
                onClick={handleDeploy}
                disabled={deployApplication.isPending}
              >
                {deployApplication.isPending ? (
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <IconPlayerPlay className="h-4 w-4 mr-2" />
                )}
                Deploy
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="font-medium">
                  {environment?.name ?? "—"}
                  {environment && (
                    <span className="ml-1 text-muted-foreground font-normal">
                      ({environment.networkType})
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Public URL</dt>
                <dd className="font-medium">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {url.replace("https://", "")}
                      <IconExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last applied</dt>
                <dd className="font-medium">
                  {formatDateTime(primaryStack?.lastAppliedAt ?? null)}
                  {primaryStack?.lastAppliedVersion != null && (
                    <span className="ml-1 text-muted-foreground font-normal">
                      (v{primaryStack.lastAppliedVersion})
                    </span>
                  )}
                </dd>
              </div>
              {primaryStack?.lastAppliedSnapshot?.services?.length ? (
                <div>
                  <dt className="text-muted-foreground">Images</dt>
                  <dd className="font-mono text-xs space-y-0.5">
                    {primaryStack.lastAppliedSnapshot.services.map((s) => (
                      <div key={s.serviceName} className="truncate">
                        {s.dockerImage}:{s.dockerTag}
                      </div>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No deployment history yet.
              </p>
            ) : (
              <>
                <ul className="divide-y">
                  {recent.map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} />
                  ))}
                </ul>
                <div className="mt-3 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      navigate(`/applications/${template.id}/history`)
                    }
                  >
                    View full history
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {!hasStacks && template.environmentId && (
            <Button
              onClick={handleDeploy}
              disabled={deployApplication.isPending}
            >
              {deployApplication.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconPlayerPlay className="h-4 w-4 mr-2" />
              )}
              Deploy
            </Button>
          )}
          {hasStacks && (
            <Button
              variant="outline"
              onClick={handleStop}
              disabled={stopApplication.isPending || isDeploying}
            >
              {stopApplication.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconPlayerStop className="h-4 w-4 mr-2" />
              )}
              Stop
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() =>
              navigate(`/applications/${template.id}/configuration`)
            }
          >
            <IconPencil className="h-4 w-4 mr-2" />
            Edit configuration
          </Button>
          <Button
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <IconTrash className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Application</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;
              {template.displayName}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteApplication.isPending}
            >
              {deleteApplication.isPending && (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
