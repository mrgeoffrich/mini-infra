import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconApps,
  IconPlus,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconDots,
  IconPencil,
  IconTrash,
  IconAlertCircle,
  IconLoader2,
  IconPackage,
  IconExternalLink,
  IconPlugConnected,
  IconPlugConnectedX,
  IconWorld,
  IconDatabase,
} from "@tabler/icons-react";
import {
  useApplications,
  useDeleteApplication,
  useDeployApplication,
  useStopApplication,
  useUserStacks,
} from "@/hooks/use-applications";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import { useEnvironments } from "@/hooks/use-environments";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { UpdateApplicationDialog } from "./update-application-dialog";
import type { StackTemplateInfo, StackInfo, StackServiceType } from "@mini-infra/types";

function getAppServiceType(
  app: StackTemplateInfo,
  stacks: StackInfo[] | undefined,
): StackServiceType | null {
  // Prefer from deployed stack services
  if (stacks?.length) {
    const svc = stacks[0].services?.[0];
    if (svc) return svc.serviceType;
  }
  // Fall back to template version service types (summary list only carries types, not full service objects)
  const templateServiceType = app.currentVersion?.serviceTypes?.[0];
  if (templateServiceType) return templateServiceType;
  return null;
}

function isAdoptedWeb(
  app: StackTemplateInfo,
  stacks: StackInfo[] | undefined,
): boolean {
  return getAppServiceType(app, stacks) === "AdoptedWeb";
}

export default function ApplicationsPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useApplications();
  const deleteApplication = useDeleteApplication();
  const deployApplication = useDeployApplication();
  const stopApplication = useStopApplication();
  const { registerTask } = useTaskTracker();
  const { data: stacksData } = useUserStacks();
  const { data: envData } = useEnvironments();

  const [deleteTarget, setDeleteTarget] = useState<StackTemplateInfo | null>(null);
  const [updateTarget, setUpdateTarget] = useState<StackTemplateInfo | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const applications = data?.data ?? [];
  const userStacks = stacksData?.data ?? [];

  // Build a map from templateId to all stacks for that template
  const stacksByTemplateId = useMemo(() => {
    const map = new Map<string, StackInfo[]>();
    for (const stack of userStacks) {
      if (stack.templateId) {
        const existing = map.get(stack.templateId) ?? [];
        existing.push(stack);
        map.set(stack.templateId, existing);
      }
    }
    return map;
  }, [userStacks]);

  // Build a map from environmentId to environment name
  const environmentNameById = useMemo(() => {
    const map = new Map<string, string>();
    const environments = envData?.environments ?? [];
    for (const env of environments) {
      map.set(env.id, env.name);
    }
    return map;
  }, [envData]);

  const getAppUrl = (app: StackTemplateInfo): string | null => {
    const stacks = stacksByTemplateId.get(app.id);
    if (!stacks || stacks.length === 0) return null;
    const stack = stacks.find((s) => s.status === "synced") ?? stacks[0];
    if (stack.status !== "synced") return null;
    const fqdn =
      stack.tunnelIngress?.[0]?.fqdn ?? stack.dnsRecords?.[0]?.fqdn;
    return fqdn ? `https://${fqdn}` : null;
  };

  const handleDeploy = async (app: StackTemplateInfo) => {
    if (!app.environmentId) return;
    try {
      await deployApplication.mutateAsync({
        templateId: app.id,
        name: app.name,
        environmentId: app.environmentId,
        onStackCreated: (stackId) => {
          registerTask({
            id: stackId,
            type: "stack-apply",
            label: `Deploying ${app.displayName ?? app.name}`,
            channel: Channel.STACKS,
          });
        },
      });
    } catch {
      // Error handled by mutation
    }
  };

  const handleStop = async (app: StackTemplateInfo) => {
    const stacks = stacksByTemplateId.get(app.id);
    if (!stacks || stacks.length === 0) {
      return;
    }
    setStoppingId(app.id);
    try {
      for (const stack of stacks) {
        registerTask({
          id: stack.id,
          type: "stack-destroy",
          label: `Stopping ${app.displayName ?? app.name}`,
          channel: Channel.STACKS,
        });
      }
      await Promise.all(stacks.map((s) => stopApplication.mutateAsync(s.id)));
    } finally {
      setStoppingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteApplication.mutateAsync({
        templateId: deleteTarget.id,
      });
    } finally {
      setDeleteTarget(null);
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-96" />
            </div>
          </div>
        </div>
        <div className="px-4 lg:px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-48 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconApps className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Applications</h1>
            </div>
          </div>

          <Alert variant="destructive" className="mt-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load applications. Please try refreshing the page.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  // Main content
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header with action buttons */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconApps className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Applications</h1>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate("/applications/adopt")}>
              <IconPlugConnected className="h-4 w-4 mr-2" />
              Connect Existing Container
            </Button>
            <Button onClick={() => navigate("/applications/new")} data-tour="applications-add-button">
              <IconPlus className="h-4 w-4 mr-2" />
              New Application
            </Button>
          </div>
        </div>
      </div>

      {/* Applications grid */}
      <div className="px-4 lg:px-6" data-tour="applications-grid">
        {applications.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <IconPackage className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium mb-1">No applications yet</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-md">
                Create a new application template to get started.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => navigate("/applications/adopt")}>
                  <IconPlugConnected className="h-4 w-4 mr-2" />
                  Connect Existing Container
                </Button>
                <Button onClick={() => navigate("/applications/new")}>
                  <IconPlus className="h-4 w-4 mr-2" />
                  New Application
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {applications.map((app) => {
              const appStacks = stacksByTemplateId.get(app.id);
              const adopted = isAdoptedWeb(app, appStacks);
              const serviceType = getAppServiceType(app, appStacks);
              const hasStacks = !!appStacks && appStacks.length > 0;
              const isBusy = stoppingId === app.id
                || appStacks?.some((s) => s.status === "pending");
              return (
                <Card
                  key={app.id}
                  className={`group transition-shadow ${isBusy ? "opacity-60 pointer-events-none" : "hover:shadow-md"}`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-base truncate flex items-center gap-1.5">
                          {serviceType === "AdoptedWeb" && (
                            <IconPlugConnected className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          {serviceType === "StatelessWeb" && (
                            <IconWorld className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          {serviceType === "Stateful" && (
                            <IconDatabase className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          {app.displayName}
                        </CardTitle>
                        {(() => {
                          const url = getAppUrl(app);
                          if (url) {
                            return (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors truncate"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="truncate">{url.replace("https://", "")}</span>
                                <IconExternalLink className="h-3 w-3 shrink-0" />
                              </a>
                            );
                          }
                          return null;
                        })()}
                        {app.description && (
                          <CardDescription className="mt-1 line-clamp-2">
                            {app.description}
                          </CardDescription>
                        )}
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                          >
                            <IconDots className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => navigate(`/applications/${app.id}`)}
                          >
                            <IconPencil className="h-4 w-4 mr-2" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(app)}
                          >
                            <IconTrash className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardHeader>

                  <CardContent className="pt-0">
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      {app.isArchived && (
                        <Badge variant="destructive">Archived</Badge>
                      )}
                      {(() => {
                        if (!appStacks || appStacks.length === 0) return null;
                        const displayStack = appStacks.find((s) => s.status === "synced")
                          ?? appStacks.find((s) => s.status === "pending")
                          ?? appStacks[0];
                        return (
                          <Badge
                            variant={
                              displayStack.status === "synced"
                                ? "default"
                                : "outline"
                            }
                          >
                            {displayStack.status === "synced"
                              ? (adopted ? "Connected" : "Running")
                              : displayStack.status ?? "Deployed"}
                          </Badge>
                        );
                      })()}
                      {app.environmentId && environmentNameById.get(app.environmentId) && (
                        <Badge variant="outline" className="text-xs">
                          {environmentNameById.get(app.environmentId)}
                        </Badge>
                      )}
                    </div>

                    <div className="flex gap-2">
                      {!hasStacks && app.environmentId && (
                        <Button
                          size="sm"
                          className="flex-1"
                          onClick={() => handleDeploy(app)}
                        >
                          {adopted ? (
                            <IconPlugConnected className="h-4 w-4 mr-1" />
                          ) : (
                            <IconPlayerPlay className="h-4 w-4 mr-1" />
                          )}
                          {adopted ? "Connect" : "Deploy"}
                        </Button>
                      )}
                      {hasStacks && (
                        <>
                          {!adopted && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1"
                              onClick={() => setUpdateTarget(app)}
                            >
                              <IconRefresh className="h-4 w-4 mr-1" />
                              Update
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1"
                            disabled={stoppingId === app.id}
                            onClick={() => handleStop(app)}
                          >
                            {stoppingId === app.id ? (
                              <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : adopted ? (
                              <IconPlugConnectedX className="h-4 w-4 mr-1" />
                            ) : (
                              <IconPlayerStop className="h-4 w-4 mr-1" />
                            )}
                            {adopted ? "Disconnect" : "Stop"}
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Update application dialog */}
      <UpdateApplicationDialog
        open={!!updateTarget}
        onOpenChange={(open) => {
          if (!open) setUpdateTarget(null);
        }}
        application={updateTarget}
        stack={updateTarget ? (stacksByTemplateId.get(updateTarget.id)?.[0] ?? null) : null}
      />

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Application</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.displayName}&quot;?
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
