import { useState } from "react";
import { useStackTemplates, useInstantiateTemplate, useTemplatePrerequisites } from "@/hooks/use-stack-templates";
import type { StackTemplateInfo, StackTemplateLinkedStack } from "@mini-infra/types";
import { StackPlanView, StackStatusBadge } from "@/components/stacks";
import { PrerequisitesBanner } from "@/components/stacks/PrerequisitesBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconStack2,
  IconRefresh,
  IconChevronDown,
  IconChevronUp,
  IconAlertCircle,
  IconRocket,
  IconLoader2,
} from "@tabler/icons-react";
import { toast } from "sonner";

interface HostTemplatesListProps {
  className?: string;
}

export function HostTemplatesList({ className }: HostTemplatesListProps) {
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);
  const instantiate = useInstantiateTemplate();

  const {
    data: templates,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useStackTemplates({ scope: "host", source: "system", includeLinkedStacks: true });

  const toggleExpanded = (templateId: string) => {
    setExpandedTemplateId((prev) => (prev === templateId ? null : templateId));
  };

  const handleDeploy = async (template: StackTemplateInfo) => {
    try {
      await instantiate.mutateAsync({ templateId: template.id });
      toast.success(`Stack created from ${template.displayName}`);
      // Expand to show the plan
      setExpandedTemplateId(template.id);
    } catch (err) {
      toast.error(`Failed to deploy: ${(err as Error).message}`);
    }
  };

  // Get the host-scoped linked stack for a template (no environmentId)
  const getHostStack = (template: StackTemplateInfo): StackTemplateLinkedStack | undefined => {
    return template.linkedStacks?.find((s) => s.environmentId === null);
  };

  const isDeployable = (stack: StackTemplateLinkedStack | undefined): boolean => {
    return !stack || stack.status === "removed" || stack.status === "undeployed";
  };

  if (isError) {
    return (
      <div className={className}>
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load templates: {error instanceof Error ? error.message : "Unknown error"}
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
                <CardTitle>Infrastructure Stacks</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Host-level infrastructure templates and their deployments
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isRefetching}
            >
              <IconRefresh className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
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
          ) : !templates || templates.length === 0 ? (
            <div className="text-center py-8">
              <IconStack2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Templates</h3>
              <p className="text-muted-foreground">
                No host-level infrastructure templates are available.
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              {templates.map((template) => {
                const stack = getHostStack(template);
                const isExpanded = expandedTemplateId === template.id;
                const deployable = isDeployable(stack);

                return (
                  <div key={template.id} className="rounded-md border">
                    <div className="flex w-full items-center justify-between p-4">
                      <button
                        className="flex items-center gap-3 text-left hover:bg-muted/50 transition-colors flex-1"
                        onClick={() => stack && !deployable ? toggleExpanded(template.id) : undefined}
                        disabled={!stack || deployable}
                      >
                        <IconStack2 className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{template.displayName}</span>
                            {stack ? (
                              <StackStatusBadge status={stack.status} />
                            ) : (
                              <Badge variant="secondary">Not deployed</Badge>
                            )}
                          </div>
                          {template.description && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {template.description}
                            </p>
                          )}
                          {stack && stack.lastAppliedVersion !== null && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Running v{stack.lastAppliedVersion}
                              {stack.version !== stack.lastAppliedVersion && (
                                <span className="text-orange-600 dark:text-orange-400 ml-2">
                                  (latest v{stack.version})
                                </span>
                              )}
                            </p>
                          )}
                        </div>
                      </button>
                      <div className="flex items-center gap-2">
                        {deployable && (
                          <Button
                            size="sm"
                            onClick={() => stack ? toggleExpanded(template.id) : handleDeploy(template)}
                            disabled={instantiate.isPending}
                          >
                            {instantiate.isPending ? (
                              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <IconRocket className="h-4 w-4 mr-2" />
                            )}
                            {stack ? "Redeploy" : "Deploy"}
                          </Button>
                        )}
                        {stack && !deployable && (
                          <button onClick={() => toggleExpanded(template.id)}>
                            {isExpanded ? (
                              <IconChevronUp className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <IconChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                    {isExpanded && stack && (
                      <div className="border-t p-4">
                        <StackPlanView stackId={stack.id} />
                      </div>
                    )}
                    {/* Soft-warn pre-deploy: show unmet template prereqs as
                        a hint when the user is about to instantiate.
                        Doesn't block the deploy button — instantiation
                        is allowed even with unmet prereqs (the resulting
                        stack lands in `pending`). The hard block fires
                        on the apply route. */}
                    {!stack && deployable && (
                      <TemplatePrereqHint templateId={template.id} scope="host" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface TemplatePrereqHintProps {
  templateId: string;
  scope: "host" | "environment";
  environmentId?: string;
}

/**
 * Soft-warn renderer for a template's cross-stack prereqs. Hidden when
 * prereqs are met, the template has no `requires` declared, or the
 * precheck endpoint fails (we don't want a precheck error to scare the
 * user out of deploying — the apply route's hard gate will catch real
 * issues). Used by both the host template list (above) and the
 * environment stacks list (separate file, same component shape).
 */
function TemplatePrereqHint({ templateId, scope, environmentId }: TemplatePrereqHintProps) {
  const { data, isError } = useTemplatePrerequisites({
    templateId,
    environmentId: scope === "environment" ? environmentId : undefined,
    enabled: scope === "host" || !!environmentId,
  });
  if (isError || !data || data.ok) return null;
  return (
    <div className="border-t p-4">
      <PrerequisitesBanner evaluation={data} severity="warning" />
    </div>
  );
}
