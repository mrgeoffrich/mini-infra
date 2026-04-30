/**
 * Per-environment firewall enable strip for the /egress page header.
 *
 * Hosts the Egress Firewall Agent host-singleton status card and a compact
 * grid of per-env firewall toggles. Defaults to collapsed when every env's
 * firewall is enabled — the common steady state.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  IconShieldLock,
  IconCheck,
  IconX,
  IconSettings,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useEnvironments } from "@/hooks/use-environments";
import { useEgressFwAgentStatus } from "@/hooks/use-egress-fw-agent";
import { EgressFirewallCard } from "./egress-firewall-card";
import type { EgressFwAgentStatus } from "@mini-infra/types";

function FwAgentStatusCard({
  status,
  isLoading,
}: {
  status: EgressFwAgentStatus | undefined;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconShieldLock className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <CardTitle className="text-base">Egress Firewall Agent</CardTitle>
            <CardDescription>
              Host-singleton sidecar that pushes rules and container maps into
              the kernel. Required for any environment running the egress
              firewall.
            </CardDescription>
            <div className="flex items-center gap-2 pt-1">
              {isLoading ? (
                <Skeleton className="h-5 w-24" />
              ) : status?.available ? (
                <Badge
                  variant="outline"
                  className="border-green-500 text-green-700 dark:text-green-400"
                >
                  <IconCheck className="h-3 w-3 mr-1" />
                  Healthy
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-red-500 text-red-700 dark:text-red-400"
                >
                  <IconX className="h-3 w-3 mr-1" />
                  Unavailable
                </Badge>
              )}
              {!isLoading && status && (
                <span className="text-xs text-muted-foreground">
                  Container{" "}
                  {status.containerRunning ? "running" : "not running"}
                  {status.reason ? ` — ${status.reason}` : ""}
                </span>
              )}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/settings-egress-fw-agent">
            <IconSettings className="h-3.5 w-3.5 mr-1" />
            Settings
          </Link>
        </Button>
      </CardHeader>
    </Card>
  );
}

export function EgressEnvironmentsStrip() {
  const envQuery = useEnvironments({ filters: { page: 1, limit: 100 } });
  const fwAgentQuery = useEgressFwAgentStatus();

  const environments = envQuery.data?.environments ?? [];
  const allEnabled =
    environments.length > 0 &&
    environments.every((e) => e.egressFirewallEnabled === true);

  // Default open when at least one env is disabled (so the user sees the
  // toggle); collapsed when everything is on (steady state).
  const [open, setOpen] = useState<boolean>(!allEnabled);

  const enabledCount = environments.filter(
    (e) => e.egressFirewallEnabled === true,
  ).length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            {open ? (
              <IconChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <IconChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-sm font-medium">Firewall agent &amp; environments</span>
            {!envQuery.isLoading && environments.length > 0 && (
              <Badge variant="outline" className="text-xs">
                {enabledCount} / {environments.length} enabled
              </Badge>
            )}
          </div>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-3 space-y-3">
        <FwAgentStatusCard
          status={fwAgentQuery.data}
          isLoading={fwAgentQuery.isLoading}
        />

        {envQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : environments.length === 0 ? (
          <p className="text-xs text-muted-foreground italic px-1">
            No environments yet — create one to start managing egress.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {environments.map((env) => (
              <EgressFirewallCard
                key={env.id}
                environmentId={env.id}
                environmentName={env.name}
                enabled={env.egressFirewallEnabled ?? false}
                isLoading={false}
                canWrite
                compact
              />
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
