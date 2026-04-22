import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconApps,
  IconPlus,
  IconAlertCircle,
  IconLoader2,
  IconPackage,
  IconPlugConnected,
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
} from "@/components/ui/card";
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
import { ApplicationCard } from "./application-card";
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
              const isBusy = stoppingId === app.id
                || !!appStacks?.some((s) => s.status === "pending");
              return (
                <ApplicationCard
                  key={app.id}
                  app={app}
                  appStacks={appStacks}
                  environmentName={
                    app.environmentId
                      ? environmentNameById.get(app.environmentId)
                      : undefined
                  }
                  appUrl={getAppUrl(app)}
                  adopted={adopted}
                  serviceType={serviceType}
                  isBusy={isBusy}
                  isStopping={stoppingId === app.id}
                  onDeploy={handleDeploy}
                  onStop={handleStop}
                  onDelete={setDeleteTarget}
                  onEdit={(a) => navigate(`/applications/${a.id}`)}
                />
              );
            })}
          </div>
        )}
      </div>

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
