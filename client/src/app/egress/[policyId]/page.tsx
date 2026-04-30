/**
 * Per-stack egress detail page mounted at /egress/:policyId.
 *
 * Layout:
 *   ┌─ Header (back link + stack name + env badge + drift indicator)
 *   ├─ Collapsible Settings panel (mode + default-action toggles + gateway health)
 *   ├─ Rules table
 *   └─ Traffic feed scoped to this policy, with inline "Allow" on blocked rows
 *
 * The collapsible Settings panel keeps the rules+traffic workflow on screen
 * by default — users only expand the panel to change the policy posture.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconChevronDown,
  IconChevronRight,
  IconShield,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useEgressPolicy, useEgressGatewayHealth } from "@/hooks/use-egress";
import { useStack } from "@/hooks/use-stacks";
import {
  ModeToggle,
  DefaultActionToggle,
  GatewayHealthBadge,
} from "@/components/egress/egress-policy-controls";
import { EgressRulesTable } from "@/components/egress/egress-rules-table";
import { EgressTrafficFeed } from "@/components/egress/egress-traffic-feed";
import {
  EgressRuleDialog,
  type EgressRuleDialogInitialValues,
} from "@/components/egress/egress-rule-dialog";
import { EgressPromoteWizard } from "@/components/egress/egress-promote-wizard";
import type { EgressEventBroadcast, EgressRuleSummary } from "@mini-infra/types";

export default function EgressPolicyDetailPage() {
  const { policyId } = useParams<{ policyId: string }>();

  const policyQuery = useEgressPolicy(policyId ?? "");
  const policy = policyQuery.data;

  const stackQuery = useStack(policy?.stackId ?? "");
  const serviceNames: string[] = (
    stackQuery.data?.data?.services ?? []
  ).map((s) => s.serviceName);

  const gatewayHealth = useEgressGatewayHealth(policy?.environmentId ?? null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promoteWizardOpen, setPromoteWizardOpen] = useState(false);

  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [ruleDialogInitial, setRuleDialogInitial] =
    useState<EgressRuleDialogInitialValues | undefined>(undefined);

  const handleAllowEvent = (event: EgressEventBroadcast) => {
    setRuleDialogInitial({
      pattern: event.destination,
      action: "allow",
      targets: event.sourceServiceName ? [event.sourceServiceName] : [],
    });
    setRuleDialogOpen(true);
  };

  // ---- Loading ----
  if (policyQuery.isLoading || !policyId) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6 max-w-7xl space-y-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  // ---- Error / not found ----
  if (policyQuery.isError || !policy) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6 max-w-7xl space-y-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/egress">
              <IconArrowLeft className="h-4 w-4 mr-1" />
              Back to Egress
            </Link>
          </Button>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {policyQuery.error instanceof Error
                ? policyQuery.error.message
                : "Egress policy not found."}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const rules: EgressRuleSummary[] = policy.rules ?? [];
  const hasDrift =
    policy.appliedVersion !== null && policy.version !== policy.appliedVersion;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Back link */}
      <div className="px-4 lg:px-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to="/egress">
            <IconArrowLeft className="h-4 w-4 mr-1" />
            Back to Egress
          </Link>
        </Button>
      </div>

      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconShield className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">
              {policy.stackNameSnapshot}
            </h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {policy.environmentNameSnapshot && (
                <Badge variant="outline" className="text-xs">
                  {policy.environmentNameSnapshot}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                Version {policy.version}
              </span>
              {hasDrift && (
                <span className="text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1">
                  <IconAlertCircle className="h-3 w-3" />
                  Running v{policy.appliedVersion}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-6">
        {/* Collapsible Settings panel */}
        <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                {settingsOpen ? (
                  <IconChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <IconChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-sm font-medium">Settings</span>
                <Badge
                  variant="outline"
                  className="text-xs capitalize"
                  title="Current mode"
                >
                  {policy.mode}
                </Badge>
                <GatewayHealthBadge health={gatewayHealth} />
              </div>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent className="mt-3">
            <div className="rounded-md border p-4 space-y-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-medium">Mode</p>
                  <p className="text-xs text-muted-foreground">
                    Detect observes traffic only; Enforce drops anything not
                    matching an allow rule (when default action is Block).
                  </p>
                </div>
                <ModeToggle
                  policy={policy}
                  onOpenPromoteWizard={() => setPromoteWizardOpen(true)}
                />
              </div>

              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-medium">Default action</p>
                  <p className="text-xs text-muted-foreground">
                    What happens to traffic that no rule matches. Disabled
                    while in Detect mode.
                  </p>
                </div>
                <DefaultActionToggle policy={policy} />
              </div>

              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Gateway health</p>
                <GatewayHealthBadge health={gatewayHealth} />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Rules */}
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Rules</h2>
            <p className="text-sm text-muted-foreground">
              Allow / block patterns applied to this stack's outbound traffic.
            </p>
          </div>
          <EgressRulesTable
            policyId={policy.id}
            serviceNames={serviceNames}
            canWrite
          />
        </div>

        {/* Traffic */}
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Traffic</h2>
            <p className="text-sm text-muted-foreground">
              Live and historical outbound DNS / SNI events for this stack
              (newest first). Click <strong>Allow</strong> on a blocked row to
              create an allow rule pre-filled with the destination.
            </p>
          </div>
          <EgressTrafficFeed
            policyId={policy.id}
            onAllowEvent={handleAllowEvent}
          />
        </div>
      </div>

      {/* Hosted dialogs */}
      <EgressRuleDialog
        open={ruleDialogOpen}
        onOpenChange={(o) => {
          setRuleDialogOpen(o);
          if (!o) setRuleDialogInitial(undefined);
        }}
        policyId={policy.id}
        serviceNames={serviceNames}
        initialValues={ruleDialogInitial}
      />

      <EgressPromoteWizard
        open={promoteWizardOpen}
        onOpenChange={setPromoteWizardOpen}
        policyId={policy.id}
        existingRules={rules}
      />
    </div>
  );
}
