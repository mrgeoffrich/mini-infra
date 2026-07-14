import { useState } from "react";
import { Link } from "react-router-dom";
import { IconArrowBigUpLine, IconExternalLink, IconPlus } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StackStatusBadge } from "@/components/stacks/StackStatusBadge";
import {
  NeedsAttentionBadge,
  StrandedAheadBadge,
  UpdateAvailableBadge,
} from "@/components/stacks/stack-indicators";
import { DeployToEnvironmentDialog } from "@/app/applications/_components/deploy-to-environment-dialog";
import { PromoteToEnvironmentDialog } from "@/components/stacks/PromoteToEnvironmentDialog";
import { useEnvironments } from "@/hooks/use-environments";
import type { StackInfo, StackTemplateInfo } from "@mini-infra/types";

/**
 * One row per environment this application is deployed into.
 *
 * The model has always supported one template installed into several environments
 * — the stacks are already there, and bulk Stop/Apply/Remove already fan out over
 * all of them. The UI just collapsed it: a `pickPrimaryStack` heuristic chose one
 * stack (first synced, else first pending, else [0]) and every status, version and
 * link on the page described only that one. If staging was healthy and production
 * was down, the page could well have told you everything was fine.
 *
 * This panel is the honest view: every deployment, its own status, its own
 * installed version, its own link.
 */
export function EnvironmentsPanel({
  template,
  stacks,
}: {
  template: StackTemplateInfo;
  stacks: StackInfo[];
}) {
  const { data: envData } = useEnvironments();
  const [deployOpen, setDeployOpen] = useState(false);
  // The row the operator chose to promote *from*; null when the dialog is shut.
  const [promoteFrom, setPromoteFrom] = useState<StackInfo | null>(null);

  const envNameById = new Map(
    (envData?.environments ?? []).map((e) => [e.id, e.name] as const),
  );

  return (
    <Card data-tour="application-environments-panel">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>Environments</CardTitle>
            <CardDescription>
              {stacks.length === 0
                ? "This application isn't deployed anywhere yet."
                : `Deployed in ${stacks.length} environment${stacks.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setDeployOpen(true)}>
            <IconPlus className="mr-1 h-4 w-4" />
            Deploy to environment
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {stacks.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Deploy it into an environment to get started.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Environment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Template version</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {stacks.map((stack) => (
                <TableRow key={stack.id}>
                  <TableCell>
                    {/* The environment comes from the STACK, not the template.
                        The application pages read it off `template.environmentId`,
                        which is a single pin and cannot describe a second
                        deployment at all. */}
                    <span className="font-medium">
                      {stack.environmentId
                        ? (envNameById.get(stack.environmentId) ?? stack.environmentId)
                        : "Host"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <StackStatusBadge status={stack.status} />
                      <NeedsAttentionBadge stack={stack} />
                      {stack.templateUpdateAvailable && <UpdateAvailableBadge />}
                      <StrandedAheadBadge stack={stack} />
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {stack.templateVersion != null ? (
                      <span className="font-mono">v{stack.templateVersion}</span>
                    ) : (
                      "—"
                    )}
                    {stack.templateVersionRelation === "behind" && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (latest v{stack.templateCurrentVersion})
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {/* Promotion reads naturally from the source row: you are
                          looking at staging, and you push what it has elsewhere.
                          Only offered when there is somewhere to push it to and
                          something to push. */}
                      {stacks.length > 1 && stack.templateVersionId != null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPromoteFrom(stack)}
                          data-tour="application-promote-action"
                        >
                          <IconArrowBigUpLine className="mr-1 h-3.5 w-3.5" />
                          Promote
                        </Button>
                      )}
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/stacks/${stack.id}`}>
                          Manage
                          <IconExternalLink className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <DeployToEnvironmentDialog
        template={template}
        stacks={stacks}
        open={deployOpen}
        onOpenChange={setDeployOpen}
      />

      {promoteFrom && (
        <PromoteToEnvironmentDialog
          // Keyed by source stack so switching rows resets the dialog's picker
          // and diff rather than showing the previous row's target.
          key={promoteFrom.id}
          sourceStack={promoteFrom}
          stacks={stacks}
          environmentNameById={envNameById}
          open
          onOpenChange={(next) => {
            if (!next) setPromoteFrom(null);
          }}
        />
      )}
    </Card>
  );
}

/**
 * Honest one-line summary for the application card: how many environments, and
 * how many of them want a human.
 *
 * The card used to render the primary stack's status badge alone, which for a
 * multi-environment application is a claim about one deployment presented as a
 * claim about the application.
 */
export function EnvironmentsSummary({ stacks }: { stacks: StackInfo[] }) {
  if (stacks.length <= 1) return null;

  const needsAttention = stacks.filter((s) => s.needsAttention?.needsAttention).length;

  return (
    <Badge variant="outline" className="text-xs">
      {stacks.length} environments
      {needsAttention > 0 && ` · ${needsAttention} needs attention`}
    </Badge>
  );
}
