import { useMemo, useState } from "react";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconExternalLink,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
} from "@tabler/icons-react";
import {
  useApplication,
  useDeleteApplication,
  useDeployApplication,
  useStopApplication,
  useUserStacks,
} from "@/hooks/use-applications";
import { useStackStatus } from "@/hooks/use-stacks";
import { useEnvironments } from "@/hooks/use-environments";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import type {
  Environment,
  StackContainerStatus,
  StackInfo,
  StackTemplateInfo,
} from "@mini-infra/types";
import { ConfigNavProvider } from "./config-nav-context";
import { PageNav } from "./page-nav";

export interface ApplicationDetailContext {
  templateId: string;
  template: StackTemplateInfo;
  stacks: StackInfo[];
  primaryStack: StackInfo | null;
  /** Live container status for the primary stack — empty array when no stack or Docker is unreachable. */
  containerStatus: StackContainerStatus[];
  environment: Environment | undefined;
  url: string | null;
}

function pickPrimaryStack(stacks: StackInfo[]): StackInfo | null {
  return (
    stacks.find((s) => s.status === "synced")
      ?? stacks.find((s) => s.status === "pending")
      ?? stacks[0]
      ?? null
  );
}

function getAppUrl(stack: StackInfo | null): string | null {
  if (!stack || stack.status !== "synced") return null;
  const fqdn = stack.tunnelIngress?.[0]?.fqdn ?? stack.dnsRecords?.[0]?.fqdn;
  return fqdn ? `https://${fqdn}` : null;
}

export default function ApplicationDetailLayout() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { registerTask } = useTaskTracker();

  const { data: appData, isLoading, error } = useApplication(id ?? "");
  const { data: stacksData } = useUserStacks();
  const { data: envData } = useEnvironments();

  const deployApplication = useDeployApplication();
  const stopApplication = useStopApplication();
  const deleteApplication = useDeleteApplication();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const template = appData?.data ?? null;
  const stacks = useMemo(() => {
    const all = stacksData?.data ?? [];
    return template ? all.filter((s) => s.templateId === template.id) : [];
  }, [stacksData, template]);
  const primaryStack = useMemo(() => pickPrimaryStack(stacks), [stacks]);
  const { data: stackStatusData } = useStackStatus(primaryStack?.id ?? "");
  const containerStatus = stackStatusData?.data?.containerStatus ?? [];
  const environment = useMemo(() => {
    const envs = envData?.environments ?? [];
    return template?.environmentId
      ? envs.find((e) => e.id === template.environmentId)
      : undefined;
  }, [envData, template]);
  const url = useMemo(() => getAppUrl(primaryStack), [primaryStack]);

  const hasStacks = stacks.length > 0;
  const isDeploying = primaryStack?.status === "pending";

  const handleDeploy = async () => {
    if (!template?.environmentId) return;
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
    if (!hasStacks || !template) return;
    try {
      for (const stack of stacks) {
        registerTask({
          id: stack.id,
          type: "stack-destroy",
          label: `Stopping ${template.displayName ?? template.name}`,
          channel: Channel.STACKS,
        });
      }
      await Promise.all(stacks.map((s) => stopApplication.mutateAsync(s.id)));
    } catch {
      // toast handled by mutation
    }
  };

  const handleDelete = async () => {
    if (!template) return;
    try {
      await deleteApplication.mutateAsync({ templateId: template.id });
      navigate("/applications");
    } finally {
      setConfirmDelete(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-10 w-80" />
          <Skeleton className="h-5 w-96 mt-2" />
        </div>
        <div className="px-4 lg:px-6 max-w-3xl space-y-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !template || !id) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/applications")}
            className="mb-4"
          >
            <IconArrowLeft className="h-4 w-4 mr-1" />
            Back to Applications
          </Button>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {error?.message ?? "Failed to load application."}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const stackStatus = primaryStack?.status;
  const statusBadge = !primaryStack ? (
    <Badge variant="outline">Not deployed</Badge>
  ) : stackStatus === "synced" ? (
    <Badge>Running</Badge>
  ) : stackStatus === "error" ? (
    <Badge variant="destructive">Error</Badge>
  ) : (
    <Badge variant="outline">{stackStatus}</Badge>
  );

  const context: ApplicationDetailContext = {
    templateId: id,
    template,
    stacks,
    primaryStack,
    containerStatus,
    environment,
    url,
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/applications")}
          className="mb-4"
        >
          <IconArrowLeft className="h-4 w-4 mr-1" />
          Back to Applications
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold truncate">
              {template.displayName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {statusBadge}
              {environment && (
                <Badge variant="outline">
                  {environment.name}
                  <span className="ml-1 text-muted-foreground">
                    ({environment.networkType})
                  </span>
                </Badge>
              )}
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {url.replace("https://", "")}
                  <IconExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            {template.description && (
              <p className="text-muted-foreground mt-2 max-w-2xl">
                {template.description}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!hasStacks && template.environmentId && (
              <Button onClick={handleDeploy} disabled={deployApplication.isPending}>
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
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <IconTrash className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </div>
        </div>
      </div>

      <ConfigNavProvider>
        <div className="px-4 lg:px-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_minmax(0,1fr)] md:items-start">
            <PageNav basePath={`/applications/${id}`} />
            <div className="min-w-0">
              <Outlet context={context} />
            </div>
          </div>
        </div>
      </ConfigNavProvider>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete application</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{template.displayName}&quot;?
              This action cannot be undone.
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
