import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  IconShield,
  IconShieldLock,
  IconAlertCircle,
  IconCheck,
  IconX,
  IconSettings,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEnvironments, useEnvironment } from "@/hooks/use-environments";
import { useEgressPolicies } from "@/hooks/use-egress";
import { useEgressFwAgentStatus } from "@/hooks/use-egress-fw-agent";
import { EgressFirewallCard } from "@/components/egress/egress-firewall-card";
import { EgressPolicyCard } from "@/components/egress/egress-policy-card";
import { EgressTrafficFeed } from "@/components/egress/egress-traffic-feed";
import type {
  EgressPolicySummary,
  EgressFwAgentStatus,
  Environment,
} from "@mini-infra/types";

const ALL_ENVS = "__all__";

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

interface EnvironmentSectionProps {
  environment: Environment;
  policies: EgressPolicySummary[];
  canWrite: boolean;
  /** Render a section header above the firewall card; used in the all-envs view. */
  showHeader: boolean;
}

function EnvironmentSection({
  environment,
  policies,
  canWrite,
  showHeader,
}: EnvironmentSectionProps) {
  return (
    <section className="space-y-3">
      {showHeader && (
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">{environment.name}</h3>
          <Badge variant="outline" className="capitalize text-xs">
            {environment.type}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {policies.length} {policies.length === 1 ? "policy" : "policies"}
          </span>
        </div>
      )}

      <EgressFirewallCard
        environmentId={environment.id}
        environmentName={showHeader ? undefined : environment.name}
        enabled={environment.egressFirewallEnabled ?? false}
        isLoading={false}
        canWrite={canWrite}
        compact={showHeader}
      />

      {policies.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-1">
          No egress policies — policies are created automatically when stacks
          are deployed into this environment.
        </p>
      ) : (
        <div className="space-y-3">
          {policies.map((policy) => (
            <EgressPolicyCard
              key={policy.id}
              policy={policy}
              environmentId={environment.id}
              canWrite={canWrite}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function EgressPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env");
  const selectedEnvId = envParam && envParam !== ALL_ENVS ? envParam : undefined;

  const envQuery = useEnvironments({
    filters: { page: 1, limit: 100 },
  });
  const policiesQuery = useEgressPolicies({
    query: { environmentId: selectedEnvId, page: 1, limit: 200 },
  });
  const fwAgentQuery = useEgressFwAgentStatus();

  // For a single-env view, also pull the latest copy so the firewall toggle
  // reflects the current `egressFirewallEnabled` flag without a full list refetch.
  const singleEnvQuery = useEnvironment(selectedEnvId ?? "", {
    enabled: !!selectedEnvId,
  });

  const environments = envQuery.data?.environments ?? [];

  const policiesByEnv = useMemo(() => {
    const map = new Map<string, EgressPolicySummary[]>();
    for (const p of policiesQuery.data?.policies ?? []) {
      if (!p.environmentId) continue;
      const list = map.get(p.environmentId) ?? [];
      list.push(p);
      map.set(p.environmentId, list);
    }
    return map;
  }, [policiesQuery.data?.policies]);

  const isLoading = envQuery.isLoading || policiesQuery.isLoading;
  const error = envQuery.error ?? policiesQuery.error;

  // Browser sessions have full access (null permissions = full access).
  const canWrite = true;

  const handleEnvChange = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === ALL_ENVS) {
        next.delete("env");
      } else {
        next.set("env", value);
      }
      return next;
    });
  };

  const selectedEnv = selectedEnvId
    ? singleEnvQuery.data ??
      environments.find((e) => e.id === selectedEnvId) ??
      null
    : null;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconShield className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Egress</h1>
            <p className="text-muted-foreground">
              Outbound traffic control across all environments
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-6">
        <FwAgentStatusCard
          status={fwAgentQuery.data}
          isLoading={fwAgentQuery.isLoading}
        />

        {/* Environment filter */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 py-3">
            <div>
              <CardTitle className="text-sm">Environment filter</CardTitle>
              <CardDescription className="text-xs">
                Choose a single environment to focus on, or show all of them
                together.
              </CardDescription>
            </div>
            <Select
              value={selectedEnvId ?? ALL_ENVS}
              onValueChange={handleEnvChange}
              disabled={envQuery.isLoading}
            >
              <SelectTrigger className="w-64 h-9 text-sm">
                <SelectValue placeholder="All environments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ENVS}>All environments</SelectItem>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardHeader>
        </Card>

        {error && (
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load:{" "}
              {error instanceof Error ? error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        )}

        {/* Per-environment sections */}
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : selectedEnvId ? (
          // Single-env view
          selectedEnv ? (
            <EnvironmentSection
              environment={selectedEnv}
              policies={policiesByEnv.get(selectedEnvId) ?? []}
              canWrite={canWrite}
              showHeader={false}
            />
          ) : (
            <Alert variant="destructive">
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>Environment not found.</AlertDescription>
            </Alert>
          )
        ) : environments.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <IconShield className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-sm">No environments yet</p>
              <p className="text-muted-foreground text-xs mt-1">
                Create an environment to start managing egress rules.
              </p>
            </CardContent>
          </Card>
        ) : (
          // All-envs view: one section per environment
          <div className="space-y-8">
            {environments.map((env) => (
              <EnvironmentSection
                key={env.id}
                environment={env}
                policies={policiesByEnv.get(env.id) ?? []}
                canWrite={canWrite}
                showHeader
              />
            ))}
          </div>
        )}

        {/* Traffic feed (always visible, scoped to the active env filter) */}
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Traffic Feed</h2>
            <p className="text-sm text-muted-foreground">
              Live and historical outbound DNS / SNI events (newest first)
              {selectedEnv ? ` for ${selectedEnv.name}` : " across all environments"}.
            </p>
          </div>

          <EgressTrafficFeed environmentId={selectedEnvId} />
        </div>
      </div>
    </div>
  );
}
