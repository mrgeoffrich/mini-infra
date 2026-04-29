import { useState } from "react";
import {
  IconShield,
  IconAlertCircle,
  IconCheck,
  IconX,
  IconEye,
  IconLock,
  IconLockOpen,
  IconPlus,
  IconPencil,
  IconTrash,
  IconLoader2,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useStack } from "@/hooks/use-stacks";
import {
  useEgressPolicy,
  useEgressGatewayHealth,
  useDeleteEgressRule,
  usePatchEgressPolicy,
} from "@/hooks/use-egress";
import { EgressRuleDialog } from "./egress-rule-dialog";
import { EgressPromoteWizard } from "./egress-promote-wizard";
import type {
  EgressPolicySummary,
  EgressRuleSummary,
  EgressGatewayHealthEvent,
} from "@mini-infra/types";

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
      onOpenPromoteWizard();
    } else {
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
              Change default action to{" "}
              {pendingAction === "block" ? "Block" : "Allow"}?
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

// ====================
// Policy card with embedded rules table
// ====================

export interface EgressPolicyCardProps {
  policy: EgressPolicySummary;
  environmentId: string;
  canWrite: boolean;
  /** When true, prefix the title with the policy's environment name (used in cross-env views). */
  showEnvironment?: boolean;
}

export function EgressPolicyCard({
  policy,
  environmentId,
  canWrite,
  showEnvironment = false,
}: EgressPolicyCardProps) {
  const gatewayHealth = useEgressGatewayHealth(environmentId);
  const [promoteWizardOpen, setPromoteWizardOpen] = useState(false);

  const hasDrift =
    policy.appliedVersion !== null &&
    policy.version !== policy.appliedVersion;

  const stackQuery = useStack(policy.stackId ?? "");
  const serviceNames: string[] = (
    stackQuery.data?.data?.services ?? []
  ).map((s) => s.serviceName);

  const { data } = useEgressPolicy(policy.id);
  const rules: EgressRuleSummary[] = data?.rules ?? [];

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <IconShield className="h-4 w-4 text-muted-foreground shrink-0" />
              <CardTitle className="text-sm font-medium truncate">
                {showEnvironment && policy.environmentNameSnapshot
                  ? `${policy.environmentNameSnapshot} · ${policy.stackNameSnapshot}`
                  : policy.stackNameSnapshot}
              </CardTitle>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {canWrite ? (
                <ModeToggle
                  policy={policy}
                  onOpenPromoteWizard={() => setPromoteWizardOpen(true)}
                />
              ) : (
                <ModeBadge mode={policy.mode} />
              )}

              {canWrite ? (
                <DefaultActionToggle policy={policy} />
              ) : (
                <DefaultActionBadge action={policy.defaultAction} />
              )}

              <GatewayHealthBadge health={gatewayHealth} />
            </div>
          </div>

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

      <EgressPromoteWizard
        open={promoteWizardOpen}
        onOpenChange={setPromoteWizardOpen}
        policyId={policy.id}
        existingRules={rules}
      />
    </>
  );
}
