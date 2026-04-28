/**
 * Egress Firewall tab for the Environment Detail page.
 *
 * Renders three sections (top-to-bottom):
 *  1. Policy summary cards — one per stack, showing mode, defaultAction,
 *     version drift, and live gateway health.
 *  2. Rules section per policy — table of rules (pattern, action,
 *     source, targets, hits, lastHit) with edit/delete/add for egress:write users.
 *  3. Traffic feed — paginated EgressEvent table with filters and live prepend.
 *
 * Write actions (mode-toggle, rule CRUD) require `egress:write`.
 * In v1 browser sessions every user has full access (null permissions = full access).
 * A prop `canWrite` is threaded through so callers can restrict to API-key users.
 */

import { useState, useCallback } from "react";
import {
  IconShield,
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconAlertCircle,
  IconCheck,
  IconX,
  IconClock,
  IconRefresh,
  IconEye,
  IconLock,
  IconLockOpen,
  IconPlus,
  IconPencil,
  IconTrash,
  IconLoader2,
} from "@tabler/icons-react";
import {
  useEgressPolicies,
  useEgressPolicy,
  useEgressGatewayHealth,
  useEgressEvents,
  useEgressEventFilters,
  useDeleteEgressRule,
  usePatchEgressPolicy,
} from "@/hooks/use-egress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useStack } from "@/hooks/use-stacks";
import { EgressRuleDialog } from "./egress-rule-dialog";
import { EgressPromoteWizard } from "./egress-promote-wizard";
import type {
  EgressPolicySummary,
  EgressRuleSummary,
  EgressEventBroadcast,
  EgressGatewayHealthEvent,
} from "@mini-infra/types";

// ====================
// Types
// ====================

interface EgressTabProps {
  environmentId: string;
  /** Whether the current session has egress:write permission.
   *  Browser sessions have full access (null permissions = true here).
   *  Defaults to true for backward compat. */
  canWrite?: boolean;
}

// ====================
// Gateway health badge
// ====================

function GatewayHealthBadge({
  health,
}: {
  health: EgressGatewayHealthEvent | null;
}) {
  if (!health) {
    return (
      <Badge variant="outline" className="text-xs text-muted-foreground">
        Unknown
      </Badge>
    );
  }

  if (!health.ok) {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      >
        <IconX className="h-3 w-3 mr-1" />
        Error
      </Badge>
    );
  }

  const hasDrift =
    health.rulesVersion !== (health.appliedRulesVersion ?? -1) ||
    health.containerMapVersion !== (health.appliedContainerMapVersion ?? -1);

  if (hasDrift) {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
      >
        <IconAlertCircle className="h-3 w-3 mr-1" />
        Drift
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    >
      <IconCheck className="h-3 w-3 mr-1" />
      Healthy
    </Badge>
  );
}

// ====================
// Mode badge (read-only)
// ====================

function ModeBadge({ mode }: { mode: "detect" | "enforce" }) {
  if (mode === "enforce") {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300"
      >
        <IconLock className="h-3 w-3 mr-1" />
        Enforce
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
    >
      <IconEye className="h-3 w-3 mr-1" />
      Detect
    </Badge>
  );
}

// ====================
// Default action badge (read-only)
// ====================

function DefaultActionBadge({ action }: { action: "allow" | "block" }) {
  if (action === "block") {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      >
        <IconLock className="h-3 w-3 mr-1" />
        Block by default
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    >
      <IconLockOpen className="h-3 w-3 mr-1" />
      Allow by default
    </Badge>
  );
}

// ====================
// Action event badge
// ====================

function EventActionBadge({ action }: { action: string }) {
  if (action === "blocked") {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      >
        Blocked
      </Badge>
    );
  }
  if (action === "observed") {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300"
      >
        Observed
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    >
      Allowed
    </Badge>
  );
}

// ====================
// Rule source badge
// ====================

function RuleSourceBadge({ source }: { source: string }) {
  const variants: Record<string, string> = {
    user: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
    observed:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
    template:
      "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  };
  return (
    <Badge
      variant="outline"
      className={`text-xs capitalize ${variants[source] ?? ""}`}
    >
      {source}
    </Badge>
  );
}

// ====================
// Mode toggle (write mode)
// ====================

interface ModeToggleProps {
  policy: EgressPolicySummary;
  onOpenPromoteWizard: () => void;
}

function ModeToggle({ policy, onOpenPromoteWizard }: ModeToggleProps) {
  const patchPolicy = usePatchEgressPolicy();
  const [confirmDetectOpen, setConfirmDetectOpen] = useState(false);

  const handleValueChange = (value: string) => {
    if (!value) return;
    if (value === policy.mode) return;

    if (value === "enforce") {
      // Open wizard instead of direct PATCH
      onOpenPromoteWizard();
    } else {
      // Demote to detect — show confirm
      setConfirmDetectOpen(true);
    }
  };

  const handleConfirmDetect = async () => {
    try {
      await patchPolicy.mutateAsync({
        policyId: policy.id,
        body: { mode: "detect" },
      });
      toast.success("Policy switched to Detect mode");
      setConfirmDetectOpen(false);
    } catch (err) {
      toast.error(
        `Failed to switch mode: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        value={policy.mode}
        onValueChange={handleValueChange}
        disabled={patchPolicy.isPending}
        className="h-7"
      >
        <ToggleGroupItem value="detect" className="h-6 text-xs px-3">
          <IconEye className="h-3 w-3 mr-1" />
          Detect
        </ToggleGroupItem>
        <ToggleGroupItem value="enforce" className="h-6 text-xs px-3">
          <IconLock className="h-3 w-3 mr-1" />
          Enforce
        </ToggleGroupItem>
      </ToggleGroup>

      {/* Confirm demote dialog */}
      <Dialog open={confirmDetectOpen} onOpenChange={setConfirmDetectOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Switch to Detect mode?</DialogTitle>
            <DialogDescription>
              The policy will stop blocking traffic and will only observe. You
              can switch back to Enforce at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDetectOpen(false)}
              disabled={patchPolicy.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmDetect}
              disabled={patchPolicy.isPending}
            >
              {patchPolicy.isPending && (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Switch to Detect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ====================
// Default action toggle (write mode)
// ====================

interface DefaultActionToggleProps {
  policy: EgressPolicySummary;
}

function DefaultActionToggle({ policy }: DefaultActionToggleProps) {
  const patchPolicy = usePatchEgressPolicy();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"allow" | "block" | null>(
    null,
  );

  const handleValueChange = (value: string) => {
    if (!value || value === policy.defaultAction) return;
    setPendingAction(value as "allow" | "block");
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    if (!pendingAction) return;
    try {
      await patchPolicy.mutateAsync({
        policyId: policy.id,
        body: { defaultAction: pendingAction },
      });
      toast.success(
        `Default action set to ${pendingAction === "block" ? "Block" : "Allow"}`,
      );
      setConfirmOpen(false);
      setPendingAction(null);
    } catch (err) {
      toast.error(
        `Failed to update default action: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        value={policy.defaultAction}
        onValueChange={handleValueChange}
        disabled={patchPolicy.isPending || policy.mode === "detect"}
        className="h-7"
      >
        <ToggleGroupItem value="allow" className="h-6 text-xs px-3">
          Allow
        </ToggleGroupItem>
        <ToggleGroupItem value="block" className="h-6 text-xs px-3">
          Block
        </ToggleGroupItem>
      </ToggleGroup>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Change default action to {pendingAction === "block" ? "Block" : "Allow"}?
            </DialogTitle>
            <DialogDescription>
              {pendingAction === "block"
                ? "Setting default to Block means traffic without an explicit allow rule will be blocked. Existing observed traffic that hasn't been added as a rule will be blocked."
                : "Setting default to Allow means unmatched traffic will be permitted. This weakens the enforce posture."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={patchPolicy.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={pendingAction === "block" ? "destructive" : "default"}
              onClick={handleConfirm}
              disabled={patchPolicy.isPending}
            >
              {patchPolicy.isPending && (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ====================
// Policy card with embedded rules table
// ====================

interface PolicyCardProps {
  policy: EgressPolicySummary;
  environmentId: string;
  canWrite: boolean;
}

function PolicyCard({ policy, environmentId, canWrite }: PolicyCardProps) {
  const gatewayHealth = useEgressGatewayHealth(environmentId);
  const [promoteWizardOpen, setPromoteWizardOpen] = useState(false);

  const hasDrift =
    policy.appliedVersion !== null &&
    policy.version !== policy.appliedVersion;

  // Fetch stack to get service names for the rule dialog
  const stackQuery = useStack(policy.stackId ?? "");
  const serviceNames: string[] = (
    stackQuery.data?.data?.services ?? []
  ).map((s) => s.serviceName);

  const { data } = useEgressPolicy(policy.id);
  const rules: EgressRuleSummary[] = data?.data?.rules ?? [];

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <IconShield className="h-4 w-4 text-muted-foreground shrink-0" />
              <CardTitle className="text-sm font-medium truncate">
                {policy.stackNameSnapshot}
              </CardTitle>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Mode control */}
              {canWrite ? (
                <ModeToggle
                  policy={policy}
                  onOpenPromoteWizard={() => setPromoteWizardOpen(true)}
                />
              ) : (
                <ModeBadge mode={policy.mode} />
              )}

              {/* Default action control */}
              {canWrite ? (
                <DefaultActionToggle policy={policy} />
              ) : (
                <DefaultActionBadge action={policy.defaultAction} />
              )}

              <GatewayHealthBadge health={gatewayHealth} />
            </div>
          </div>

          {/* Version info */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
            <span>Version {policy.version}</span>
            {hasDrift && (
              <span className="text-orange-600 dark:text-orange-400 flex items-center gap-1">
                <IconAlertCircle className="h-3 w-3" />
                Running v{policy.appliedVersion}
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="pt-0">
          <EmbeddedRulesTable
            policyId={policy.id}
            serviceNames={serviceNames}
            canWrite={canWrite}
          />
        </CardContent>
      </Card>

      {/* Promote-to-Enforce wizard */}
      <EgressPromoteWizard
        open={promoteWizardOpen}
        onOpenChange={setPromoteWizardOpen}
        policyId={policy.id}
        existingRules={rules}
      />
    </>
  );
}

// ====================
// Embedded rules table
// ====================

interface EmbeddedRulesTableProps {
  policyId: string;
  serviceNames: string[];
  canWrite: boolean;
}

function EmbeddedRulesTable({
  policyId,
  serviceNames,
  canWrite,
}: EmbeddedRulesTableProps) {
  const { formatRelativeTime, formatDateTime } = useFormattedDate();
  const deleteMutation = useDeleteEgressRule();

  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [editRule, setEditRule] = useState<EgressRuleSummary | null>(null);
  const [deleteRuleId, setDeleteRuleId] = useState<string | null>(null);
  const [deleteRulePending, setDeleteRulePending] = useState(false);

  // useEgressPolicy is imported at the top of the file and cached by TanStack
  // Query — if a parent hook already fetched it, this is a free cache hit.
  const { data, isLoading, isError } = useEgressPolicy(policyId);
  const rules: EgressRuleSummary[] = data?.data?.rules ?? [];
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
      {/* Add rule button */}
      {canWrite && (
        <div className="flex justify-end mb-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAddRuleOpen(true)}
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

      {/* Add rule dialog */}
      <EgressRuleDialog
        open={addRuleOpen}
        onOpenChange={setAddRuleOpen}
        policyId={policyId}
        serviceNames={serviceNames}
      />

      {/* Edit rule dialog */}
      <EgressRuleDialog
        open={!!editRule}
        onOpenChange={(o) => !o && setEditRule(null)}
        policyId={policyId}
        serviceNames={serviceNames}
        rule={editRule ?? undefined}
      />

      {/* Delete confirmation */}
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

// ====================
// Traffic feed row
// ====================

function TrafficFeedRow({
  event,
  formatRelativeTime,
  formatDateTime,
}: {
  event: EgressEventBroadcast;
  formatRelativeTime: (date: string) => string;
  formatDateTime: (date: string) => string;
}) {
  return (
    <TableRow>
      <TableCell className="text-xs whitespace-nowrap">
        <span title={formatDateTime(event.occurredAt)}>
          {formatRelativeTime(event.occurredAt)}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        <div className="truncate max-w-[140px]" title={event.stackNameSnapshot}>
          {event.stackNameSnapshot}
        </div>
        {event.sourceServiceName && (
          <div
            className="text-muted-foreground truncate max-w-[140px] font-mono"
            title={event.sourceServiceName}
          >
            {event.sourceServiceName}
          </div>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs truncate max-w-[200px]">
        {event.destination}
      </TableCell>
      <TableCell>
        <EventActionBadge action={event.action} />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[160px]">
        {event.matchedPattern ?? (
          <span className="italic">none</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-right">{event.mergedHits}</TableCell>
    </TableRow>
  );
}

// ====================
// Traffic feed section
// ====================

const TIME_RANGE_OPTIONS = [
  { label: "Last 1 hour", value: "1h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
];

function sinceFromRange(range: string | undefined): string | undefined {
  if (!range) return undefined;
  const now = new Date();
  if (range === "1h") {
    return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  }
  if (range === "24h") {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }
  if (range === "7d") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return undefined;
}

function TrafficFeedSection({ environmentId }: { environmentId: string }) {
  const { formatRelativeTime, formatDateTime } = useFormattedDate();

  const [timeRange, setTimeRange] = useState<string>("24h");
  const [destinationSearch, setDestinationSearch] = useState("");

  const { filters, updateFilter, resetFilters } = useEgressEventFilters();

  const query = {
    environmentId,
    action: filters.action,
    since: sinceFromRange(timeRange),
    page: filters.page,
    limit: filters.limit,
  };

  const {
    data,
    isLoading,
    isError,
    error,
    liveEvents,
  } = useEgressEvents({ query });

  const historyEvents = data?.data ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination
    ? Math.ceil(pagination.totalCount / pagination.limit)
    : 1;

  // Merge live events and history, deduplicating on id
  const historyIds = new Set(historyEvents.map((e) => e.id));
  const filteredLive = liveEvents.filter((e) => {
    if (historyIds.has(e.id)) return false;
    if (destinationSearch) {
      return e.destination
        .toLowerCase()
        .includes(destinationSearch.toLowerCase());
    }
    return true;
  });

  const displayHistory = destinationSearch
    ? historyEvents.filter((e) =>
        e.destination.toLowerCase().includes(destinationSearch.toLowerCase()),
      )
    : historyEvents;

  const hasLive = filteredLive.length > 0;

  const handlePreviousPage = useCallback(() => {
    if (filters.page > 1) updateFilter("page", filters.page - 1);
  }, [filters.page, updateFilter]);

  const handleNextPage = useCallback(() => {
    if (filters.page < totalPages) updateFilter("page", filters.page + 1);
  }, [filters.page, totalPages, updateFilter]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <IconFilter className="h-4 w-4" />
          Filters
        </div>

        <Select
          value={filters.action ?? "all"}
          onValueChange={(v) =>
            updateFilter(
              "action",
              v === "all"
                ? undefined
                : (v as "allowed" | "blocked" | "observed"),
            )
          }
        >
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            <SelectItem value="allowed">Allowed</SelectItem>
            <SelectItem value="blocked">Blocked</SelectItem>
            <SelectItem value="observed">Observed</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={timeRange}
          onValueChange={(v) => {
            setTimeRange(v);
            updateFilter("page", 1);
          }}
        >
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue placeholder="Time range" />
          </SelectTrigger>
          <SelectContent>
            {TIME_RANGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="h-8 text-xs w-52"
          placeholder="Filter by destination..."
          value={destinationSearch}
          onChange={(e) => setDestinationSearch(e.target.value)}
        />

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            resetFilters();
            setTimeRange("24h");
            setDestinationSearch("");
          }}
          className="h-8 text-xs"
        >
          <IconRefresh className="h-3 w-3 mr-1" />
          Reset
        </Button>
      </div>

      {/* Pagination count */}
      {pagination && (
        <div className="text-xs text-muted-foreground">
          {hasLive && (
            <span className="text-blue-600 dark:text-blue-400 mr-2">
              {filteredLive.length} new live
            </span>
          )}
          Showing {pagination.offset + 1}–
          {Math.min(pagination.offset + pagination.limit, pagination.totalCount)}{" "}
          of {pagination.totalCount} events
        </div>
      )}

      {/* Error */}
      {isError && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load traffic events:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      )}

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">
                <span className="flex items-center gap-1">
                  <IconClock className="h-3 w-3" />
                  Time
                </span>
              </TableHead>
              <TableHead className="text-xs">Stack / Service</TableHead>
              <TableHead className="text-xs">Destination</TableHead>
              <TableHead className="text-xs">Action</TableHead>
              <TableHead className="text-xs">Matched Pattern</TableHead>
              <TableHead className="text-xs text-right">Hits</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <>
                {/* Live events — prepended at top */}
                {filteredLive.map((event) => (
                  <TrafficFeedRow
                    key={`live-${event.id}`}
                    event={event}
                    formatRelativeTime={formatRelativeTime}
                    formatDateTime={formatDateTime}
                  />
                ))}

                {/* Paginated history */}
                {displayHistory.map((event) => (
                  <TrafficFeedRow
                    key={event.id}
                    event={event}
                    formatRelativeTime={formatRelativeTime}
                    formatDateTime={formatDateTime}
                  />
                ))}

                {filteredLive.length === 0 &&
                  displayHistory.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="h-24 text-center text-muted-foreground text-sm"
                      >
                        No traffic events for the current filters.
                      </TableCell>
                    </TableRow>
                  )}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination controls */}
      {pagination && pagination.totalCount > pagination.limit && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePreviousPage}
            disabled={filters.page === 1 || isLoading}
          >
            <IconChevronLeft className="h-4 w-4 mr-1" />
            Previous
          </Button>
          <div className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            disabled={filters.page >= totalPages || isLoading}
          >
            Next
            <IconChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ====================
// Main EgressTab export
// ====================

export function EgressTab({ environmentId, canWrite = true }: EgressTabProps) {
  const {
    data: policiesData,
    isLoading: policiesLoading,
    isError: policiesError,
    error: policiesErr,
  } = useEgressPolicies({ query: { environmentId } });

  const policies: EgressPolicySummary[] = policiesData?.data ?? [];

  return (
    <div className="space-y-6">
      {/* Section: Policy summary cards */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconShield className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Egress Policies</h2>
            <p className="text-sm text-muted-foreground">
              Outbound traffic control for stacks in this environment
            </p>
          </div>
        </div>

        {policiesError && (
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load egress policies:{" "}
              {policiesErr instanceof Error
                ? policiesErr.message
                : "Unknown error"}
            </AlertDescription>
          </Alert>
        )}

        {policiesLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : policies.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <IconShield className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-sm">No egress policies</p>
              <p className="text-muted-foreground text-xs mt-1">
                Policies are created automatically when stacks are deployed into
                this environment.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                policy={policy}
                environmentId={environmentId}
                canWrite={canWrite}
              />
            ))}
          </div>
        )}
      </div>

      {/* Section: Traffic feed */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div>
            <h2 className="text-lg font-semibold">Traffic Feed</h2>
            <p className="text-sm text-muted-foreground">
              Live and historical outbound DNS / SNI events (newest first)
            </p>
          </div>
        </div>

        <TrafficFeedSection environmentId={environmentId} />
      </div>
    </div>
  );
}
