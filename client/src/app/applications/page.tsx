import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconApps,
  IconPlus,
  IconFileImport,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconDots,
  IconPencil,
  IconTrash,
  IconAlertCircle,
  IconLoader2,
  IconPackage,
} from "@tabler/icons-react";
import {
  useApplications,
  useDeleteApplication,
  useStopApplication,
  useUserStacks,
} from "@/hooks/use-applications";
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
import { ImportDeploymentDialog } from "./import-deployment-dialog";
import { DeployApplicationDialog } from "./deploy-application-dialog";
import { UpdateApplicationDialog } from "./update-application-dialog";
import type { StackTemplateInfo, StackInfo } from "@mini-infra/types";

export default function ApplicationsPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useApplications();
  const deleteApplication = useDeleteApplication();
  const stopApplication = useStopApplication();
  const { data: stacksData } = useUserStacks();
  const { data: envData } = useEnvironments();

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StackTemplateInfo | null>(null);
  const [deployTarget, setDeployTarget] = useState<StackTemplateInfo | null>(null);
  const [updateTarget, setUpdateTarget] = useState<StackTemplateInfo | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const applications = data?.data ?? [];
  const userStacks = stacksData?.data ?? [];

  // Build a map from templateId to stack for quick lookup
  const stackByTemplateId = useMemo(() => {
    const map = new Map<string, StackInfo>();
    for (const stack of userStacks) {
      if (stack.templateId) {
        map.set(stack.templateId, stack);
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

  const getServiceCount = (app: StackTemplateInfo): number => {
    return app.currentVersion?.serviceCount ?? app.currentVersion?.services?.length ?? 0;
  };

  const handleDeploy = (app: StackTemplateInfo) => {
    setDeployTarget(app);
  };

  const handleStop = async (app: StackTemplateInfo) => {
    const stack = stackByTemplateId.get(app.id);
    if (!stack) {
      return;
    }
    setStoppingId(app.id);
    try {
      await stopApplication.mutateAsync(stack.id);
    } finally {
      setStoppingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteApplication.mutateAsync(deleteTarget.id);
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
              <p className="text-muted-foreground">
                Manage your application templates
              </p>
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
              <p className="text-muted-foreground">
                Manage your application templates
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
              <IconFileImport className="h-4 w-4 mr-2" />
              Import Deployment
            </Button>
            <Button onClick={() => navigate("/applications/new")}>
              <IconPlus className="h-4 w-4 mr-2" />
              Add Application
            </Button>
          </div>
        </div>
      </div>

      {/* Applications grid */}
      <div className="px-4 lg:px-6">
        {applications.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <IconPackage className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium mb-1">No applications yet</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-md">
                Create a new application template or import an existing deployment
                configuration to get started.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
                  <IconFileImport className="h-4 w-4 mr-2" />
                  Import Deployment
                </Button>
                <Button onClick={() => navigate("/applications/new")}>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Add Application
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {applications.map((app) => {
              const serviceCount = getServiceCount(app);

              return (
                <Card
                  key={app.id}
                  className="group hover:shadow-md transition-shadow"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-base truncate">
                          {app.displayName}
                        </CardTitle>
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
                    <div className="flex items-center gap-2 mb-4">
                      <Badge variant="secondary">
                        {serviceCount} {serviceCount === 1 ? "service" : "services"}
                      </Badge>
                      {app.category && (
                        <Badge variant="outline">{app.category}</Badge>
                      )}
                      {app.isArchived && (
                        <Badge variant="destructive">Archived</Badge>
                      )}
                      {stackByTemplateId.has(app.id) && (
                        <>
                          <Badge
                            variant={
                              stackByTemplateId.get(app.id)?.status === "synced"
                                ? "default"
                                : "outline"
                            }
                          >
                            {stackByTemplateId.get(app.id)?.status === "synced"
                              ? "Running"
                              : stackByTemplateId.get(app.id)?.status ?? "Deployed"}
                          </Badge>
                          {stackByTemplateId.get(app.id)?.environmentId &&
                            environmentNameById.get(
                              stackByTemplateId.get(app.id)!.environmentId!,
                            ) && (
                              <Badge variant="outline">
                                {environmentNameById.get(
                                  stackByTemplateId.get(app.id)!.environmentId!,
                                )}
                              </Badge>
                            )}
                        </>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="flex-1"
                        onClick={() => handleDeploy(app)}
                      >
                        <IconPlayerPlay className="h-4 w-4 mr-1" />
                        Deploy
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        disabled={!stackByTemplateId.has(app.id)}
                        onClick={() => setUpdateTarget(app)}
                      >
                        <IconRefresh className="h-4 w-4 mr-1" />
                        Update
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        disabled={stoppingId === app.id || !stackByTemplateId.has(app.id)}
                        onClick={() => handleStop(app)}
                      >
                        {stoppingId === app.id ? (
                          <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <IconPlayerStop className="h-4 w-4 mr-1" />
                        )}
                        Stop
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Deploy application dialog */}
      <DeployApplicationDialog
        open={!!deployTarget}
        onOpenChange={(open) => {
          if (!open) setDeployTarget(null);
        }}
        application={deployTarget}
      />

      {/* Update application dialog */}
      <UpdateApplicationDialog
        open={!!updateTarget}
        onOpenChange={(open) => {
          if (!open) setUpdateTarget(null);
        }}
        application={updateTarget}
        stack={updateTarget ? stackByTemplateId.get(updateTarget.id) ?? null : null}
      />

      {/* Import deployment dialog */}
      <ImportDeploymentDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
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
