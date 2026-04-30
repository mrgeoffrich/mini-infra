/**
 * Standalone egress rules table.
 *
 * Renders the rules attached to a single EgressPolicy with create / edit /
 * delete affordances. Reads via useEgressPolicy(policyId) so socket-driven
 * invalidation surfaces new rules immediately.
 */

import { useState } from "react";
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconLoader2,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useEgressPolicy, useDeleteEgressRule } from "@/hooks/use-egress";
import { EgressRuleDialog } from "./egress-rule-dialog";
import { RuleSourceBadge } from "./egress-policy-controls";
import type { EgressRuleSummary } from "@mini-infra/types";

export interface EgressRulesTableProps {
  policyId: string;
  serviceNames: string[];
  canWrite: boolean;
}

export function EgressRulesTable({
  policyId,
  serviceNames,
  canWrite,
}: EgressRulesTableProps) {
  const { formatRelativeTime, formatDateTime } = useFormattedDate();
  const deleteMutation = useDeleteEgressRule();

  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [editRule, setEditRule] = useState<EgressRuleSummary | null>(null);
  const [deleteRuleId, setDeleteRuleId] = useState<string | null>(null);
  const [deleteRulePending, setDeleteRulePending] = useState(false);

  const { data, isLoading, isError } = useEgressPolicy(policyId);
  const rules: EgressRuleSummary[] = data?.rules ?? [];
  const deleteTargetRule = rules.find((r) => r.id === deleteRuleId);

  const handleDeleteConfirm = async () => {
    if (!deleteRuleId) return;
    setDeleteRulePending(true);
    try {
      await deleteMutation.mutateAsync({ ruleId: deleteRuleId, policyId });
      toast.success("Rule deleted");
      setDeleteRuleId(null);
    } catch (err) {
      toast.error(
        `Failed to delete rule: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    } finally {
      setDeleteRulePending(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Could not load rules.
      </p>
    );
  }

  return (
    <>
      {canWrite && (
        <div className="flex justify-end mb-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAddRuleOpen(true)}
            data-tour="egress-add-rule"
          >
            <IconPlus className="h-3 w-3 mr-1" />
            Add rule
          </Button>
        </div>
      )}

      {rules.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No rules defined yet.
        </p>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Pattern</TableHead>
                <TableHead className="text-xs">Action</TableHead>
                <TableHead className="text-xs">Source</TableHead>
                <TableHead className="text-xs">Targets</TableHead>
                <TableHead className="text-xs text-right">Hits</TableHead>
                <TableHead className="text-xs">Last Hit</TableHead>
                {canWrite && (
                  <TableHead className="text-xs w-16 text-right" />
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => {
                const isTemplate = rule.source === "template";
                return (
                  <TableRow key={rule.id}>
                    <TableCell className="font-mono text-xs">
                      {rule.pattern}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-xs ${
                          rule.action === "allow"
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
                            : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
                        }`}
                      >
                        {rule.action}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <RuleSourceBadge source={rule.source} />
                    </TableCell>
                    <TableCell>
                      {rule.targets.length === 0 ? (
                        <span className="text-xs text-muted-foreground italic">
                          all services
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {rule.targets.map((t) => (
                            <Badge
                              key={t}
                              variant="secondary"
                              className="text-xs font-mono"
                            >
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {rule.hits}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {rule.lastHitAt ? (
                        <span title={formatDateTime(rule.lastHitAt)}>
                          {formatRelativeTime(rule.lastHitAt)}
                        </span>
                      ) : (
                        <span className="italic">Never</span>
                      )}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {isTemplate ? (
                            <>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      disabled
                                    >
                                      <IconPencil className="h-3 w-3" />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Managed by stack template
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      disabled
                                    >
                                      <IconTrash className="h-3 w-3" />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Managed by stack template
                                </TooltipContent>
                              </Tooltip>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => setEditRule(rule)}
                              >
                                <IconPencil className="h-3 w-3" />
                                <span className="sr-only">Edit rule</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                                onClick={() => setDeleteRuleId(rule.id)}
                              >
                                <IconTrash className="h-3 w-3" />
                                <span className="sr-only">Delete rule</span>
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <EgressRuleDialog
        open={addRuleOpen}
        onOpenChange={setAddRuleOpen}
        policyId={policyId}
        serviceNames={serviceNames}
      />

      <EgressRuleDialog
        open={!!editRule}
        onOpenChange={(o) => !o && setEditRule(null)}
        policyId={policyId}
        serviceNames={serviceNames}
        rule={editRule ?? undefined}
      />

      <Dialog
        open={!!deleteRuleId}
        onOpenChange={(o) => !o && setDeleteRuleId(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              Delete Rule
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the rule for{" "}
              <code className="text-xs bg-muted rounded px-1">
                {deleteTargetRule?.pattern}
              </code>
              ? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteRuleId(null)}
              disabled={deleteRulePending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleteRulePending}
            >
              {deleteRulePending && (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete Rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
