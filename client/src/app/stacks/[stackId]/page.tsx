import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  IconArrowLeft,
  IconExternalLink,
  IconPlayerStop,
} from "@tabler/icons-react";
import { useStack, useStackStop, useStackStatusEvents } from "@/hooks/use-stacks";
import { useEnvironments } from "@/hooks/use-environments";
import { StackPlanView } from "@/components/stacks/StackPlanView";
import { StackStatusBadge } from "@/components/stacks/StackStatusBadge";
import {
  NeedsAttentionBadge,
  UpdateAvailableBadge,
  UpgradeButton,
} from "@/components/stacks/stack-indicators";
import { HistorySection } from "@/app/applications/[id]/_components/history-section";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function StackDetailPage() {
  const navigate = useNavigate();
  const { stackId } = useParams<{ stackId: string }>();
  const { data, isLoading, error } = useStack(stackId ?? "");
  const { data: envData } = useEnvironments();
  const stopStack = useStackStop();
  useStackStatusEvents();

  const stack = data?.data ?? null;

  const envName = useMemo(() => {
    if (!stack?.environmentId) return null;
    return (
      (envData?.environments ?? []).find((e) => e.id === stack.environmentId)?.name ??
      "Environment"
    );
  }, [stack, envData]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="mb-4 h-8 w-48" />
          <Skeleton className="h-10 w-72" />
          <Skeleton className="mt-4 h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !stack) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/stacks")}
            className="mb-4"
          >
            <IconArrowLeft className="mr-1 h-4 w-4" />
            Back to Stacks
          </Button>
          <Alert variant="destructive">
            <AlertDescription>
              {error instanceof Error ? error.message : "Stack not found."}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const isApplication = stack.templateSource === "user";
  const templateHref = stack.templateId
    ? isApplication
      ? `/applications/${stack.templateId}`
      : `/stack-templates/${stack.templateId}`
    : null;
  const canStop = stack.status !== "undeployed" && stack.status !== "removed";

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/stacks")}
          className="mb-4"
        >
          <IconArrowLeft className="mr-1 h-4 w-4" />
          Back to Stacks
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-bold">{stack.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StackStatusBadge status={stack.status} />
              {stack.templateUpdateAvailable && <UpdateAvailableBadge />}
              <NeedsAttentionBadge stack={stack} />
              <Badge variant="outline">
                {stack.environmentId ? envName : "Host"}
              </Badge>
              <Badge variant="outline">
                {isApplication
                  ? "Application"
                  : stack.templateSource === "system"
                    ? "Infrastructure"
                    : "Manual"}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              {stack.templateVersion != null && (
                <span>
                  Template version{" "}
                  <span className="font-mono">v{stack.templateVersion}</span>
                  {stack.templateCurrentVersion != null &&
                    stack.templateCurrentVersion !== stack.templateVersion &&
                    ` (latest v${stack.templateCurrentVersion})`}
                </span>
              )}
              {templateHref && (
                <Link
                  to={templateHref}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  {isApplication ? "View application" : "View template"}
                  <IconExternalLink className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {stack.templateUpdateAvailable && (
              <UpgradeButton stackId={stack.id} label={`Upgrading ${stack.name}`} />
            )}
            {canStop && (
              <Button
                variant="outline"
                disabled={stopStack.isPending}
                onClick={() =>
                  stopStack.mutate({ stackId: stack.id, label: `Stopping ${stack.name}` })
                }
              >
                <IconPlayerStop className="mr-2 h-4 w-4" />
                Stop
              </Button>
            )}
          </div>
        </div>

        {stack.status === "error" && stack.lastFailureReason && (
          <Alert variant="destructive" className="mt-4">
            <AlertTitle>Last apply failed</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap break-words font-mono text-xs">
              {stack.lastFailureReason}
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Plan / apply / selective apply / redeploy / uninstall — the canonical
          stack operations panel, reused from the infra lists. */}
      <div className="px-4 lg:px-6">
        <StackPlanView stackId={stack.id} onDestroyCompleted={() => navigate("/stacks")} />
      </div>

      {/* Deployment history — reused from the application activity tab. */}
      <div className="px-4 lg:px-6">
        <HistorySection primaryStack={stack} />
      </div>
    </div>
  );
}
