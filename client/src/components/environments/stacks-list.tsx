import { useState } from "react";
import { toast } from "sonner";
import { useStacks } from "@/hooks/use-stacks";
import { useStackTemplates, useInstantiateTemplate } from "@/hooks/use-stack-templates";
import type { StackInfo, StackTemplateInfo } from "@mini-infra/types";
import { StackPlanView, StackStatusBadge } from "@/components/stacks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconStack2,
  IconRefresh,
  IconChevronDown,
  IconChevronUp,
  IconAlertCircle,
  IconPlus,
} from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";

interface StacksListProps {
  environmentId?: string;
  scope?: "host";
  className?: string;
}

/**
 * Surfaces the soft NATS-drift signal layered on top of the stack status.
 * Operators see a small "NATS out of sync" badge with a tooltip listing
 * which fields drifted; clicking through to apply re-syncs everything in
 * one shot. Independent from `stack.status` because container-level sync
 * and NATS-section sync are orthogonal — a stack can be `synced` for
 * containers but have a freshly-edited (un-applied) NATS section.
 */
function NatsDriftBadge({ reasons }: { reasons: readonly string[] }) {
  const labelByReason: Record<string, string> = {
    'subject-prefix': 'Subject prefix',
    roles: 'Roles',
    signers: 'Signers',
    exports: 'Exports',
    imports: 'Imports',
    'baseline-incomplete': 'Baseline incomplete (re-apply to refresh)',
  };
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800"
          >
            NATS out of sync
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className="font-medium mb-1">NATS section differs from last apply</div>
          <ul className="list-disc pl-4 text-xs">
            {reasons.map((r) => (
              <li key={r}>{labelByReason[r] ?? r}</li>
            ))}
          </ul>
          <div className="text-xs mt-2 opacity-80">Re-apply the stack to sync.</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function StacksList({ environmentId, scope, className }: StacksListProps) {
  const [expandedStackId, setExpandedStackId] = useState<string | null>(null);
  const { formatDateTime } = useFormattedDate();

  const {
    data: stacksData,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useStacks(environmentId, { scope });

  const stacks: StackInfo[] = (stacksData?.data ?? []).filter((s) =>
    scope === "host" ? s.environmentId === null : s.environmentId !== null
  );

  // For environment-scoped views, list system templates that haven't been
  // instantiated in this environment yet. Host-scope view doesn't need this.
  const enableAvailableTemplates = scope !== "host" && !!environmentId;
  const { data: envTemplates } = useStackTemplates(
    enableAvailableTemplates
      ? { source: "system", scope: "environment", environmentId }
      : undefined,
  );
  const instantiatedNames = new Set(stacks.map((s) => s.name));
  const availableTemplates: StackTemplateInfo[] = enableAvailableTemplates
    ? (envTemplates ?? []).filter(
        (t) => !t.isArchived && !instantiatedNames.has(t.name),
      )
    : [];

  const instantiate = useInstantiateTemplate();
  const handleInstantiate = (template: StackTemplateInfo) => {
    if (!environmentId) return;
    instantiate.mutate(
      { templateId: template.id, environmentId },
      {
        onSuccess: () => {
          toast.success(`Added ${template.displayName} to environment`);
          refetch();
        },
        // No onError — the global MutationCache.onError (query-client.ts)
        // already shows an actionable toast for this mutation's real
        // ApiRequestError.
      },
    );
  };

  const toggleExpanded = (stackId: string) => {
    setExpandedStackId((prev) => (prev === stackId ? null : stackId));
  };

  if (isError) {
    return (
      <div className={className}>
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load stacks:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
                <IconStack2 className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Stacks</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {scope === "host"
                    ? "Host-level infrastructure stacks"
                    : "Infrastructure stacks in this environment"}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isRefetching}
            >
              <IconRefresh
                className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ))}
            </div>
          ) : stacks.length === 0 && availableTemplates.length === 0 ? (
            <div className="text-center py-8">
              <IconStack2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Stacks</h3>
              <p className="text-muted-foreground">
                No infrastructure stacks have been defined for this environment.
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              {stacks.map((stack) => {
                const isExpanded = expandedStackId === stack.id;

                return (
                  <div key={stack.id} className="rounded-md border">
                    <button
                      className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/50 transition-colors"
                      onClick={() => toggleExpanded(stack.id)}
                    >
                      <div className="flex items-center gap-3">
                        <IconStack2 className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {stack.name}
                            </span>
                            <StackStatusBadge status={stack.status} />
                            {stack.natsDrift?.drifted && (
                              <NatsDriftBadge reasons={stack.natsDrift.reasons} />
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
                            <span>Latest Version v{stack.version}</span>
                            {stack.lastAppliedVersion !== null &&
                              stack.lastAppliedVersion !== stack.version && (
                                <span className="text-orange-600 dark:text-orange-400">
                                  (running v{stack.lastAppliedVersion})
                                </span>
                              )}
                            {stack.services && (
                              <span>
                                {stack.services.length} service
                                {stack.services.length !== 1 ? "s" : ""}
                              </span>
                            )}
                            {stack.lastAppliedAt && (
                              <span>
                                Applied{" "}
                                {formatDateTime(stack.lastAppliedAt)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <IconChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <IconChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="border-t p-4">
                        <StackPlanView
                          stackId={stack.id}
                          onDestroyCompleted={() => setExpandedStackId(null)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              {availableTemplates.length > 0 && (
                <div className="mt-2 pt-4 border-t">
                  <p className="text-sm font-medium text-muted-foreground mb-3">
                    Available templates for this environment
                  </p>
                  <div className="grid grid-cols-1 gap-2">
                    {availableTemplates.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between rounded-md border p-3"
                      >
                        <div className="min-w-0">
                          <div className="font-medium truncate">{t.displayName}</div>
                          {t.description && (
                            <div className="text-sm text-muted-foreground truncate">
                              {t.description}
                            </div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleInstantiate(t)}
                          disabled={instantiate.isPending}
                        >
                          <IconPlus className="h-4 w-4" />
                          Add
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
