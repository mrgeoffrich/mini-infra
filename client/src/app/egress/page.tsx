import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  IconShield,
  IconShieldLock,
  IconAlertCircle,
  IconCheck,
  IconX,
  IconChevronRight,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEnvironments } from "@/hooks/use-environments";
import { useEgressPolicies } from "@/hooks/use-egress";
import { useEgressFwAgentStatus } from "@/hooks/use-egress-fw-agent";
import type {
  EgressPolicySummary,
  EgressFwAgentStatus,
} from "@mini-infra/types";

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

export default function EgressPage() {
  const envQuery = useEnvironments({
    filters: { page: 1, limit: 100 },
  });
  const policiesQuery = useEgressPolicies({
    query: { page: 1, limit: 200 },
  });
  const fwAgentQuery = useEgressFwAgentStatus();

  const environments = envQuery.data?.environments ?? [];

  const policyStatsByEnv = useMemo(() => {
    const policies: EgressPolicySummary[] =
      policiesQuery.data?.policies ?? [];
    const map = new Map<string, { total: number; enforcing: number }>();
    for (const p of policies) {
      if (!p.environmentId) continue;
      const stats = map.get(p.environmentId) ?? { total: 0, enforcing: 0 };
      stats.total += 1;
      if (p.mode === "enforce") stats.enforcing += 1;
      map.set(p.environmentId, stats);
    }
    return map;
  }, [policiesQuery.data?.policies]);

  const isLoading = envQuery.isLoading || policiesQuery.isLoading;
  const error = envQuery.error ?? policiesQuery.error;

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

        <Card>
          <CardHeader>
            <CardTitle>Environments</CardTitle>
            <CardDescription>
              Egress firewall enrolment and policy counts per environment.
              Click an environment to manage its rules and traffic feed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <IconAlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Failed to load:{" "}
                  {error instanceof Error ? error.message : "Unknown error"}
                </AlertDescription>
              </Alert>
            )}

            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : environments.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No environments yet. Create one to start managing egress rules.
              </p>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Environment</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Network</TableHead>
                      <TableHead>Firewall</TableHead>
                      <TableHead className="text-right">Policies</TableHead>
                      <TableHead className="text-right">Enforcing</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {environments.map((env) => {
                      const stats = policyStatsByEnv.get(env.id) ?? {
                        total: 0,
                        enforcing: 0,
                      };
                      const target = `/environments/${env.id}?tab=egress`;
                      return (
                        <TableRow key={env.id}>
                          <TableCell className="font-medium">
                            <Link to={target} className="hover:underline">
                              {env.name}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize">
                              {env.type}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize">
                              {env.networkType}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {env.egressFirewallEnabled ? (
                              <Badge
                                variant="outline"
                                className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
                              >
                                <IconCheck className="h-3 w-3 mr-1" />
                                Enabled
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-muted-foreground"
                              >
                                Disabled
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {stats.total}
                          </TableCell>
                          <TableCell className="text-right">
                            {stats.enforcing}
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" asChild>
                              <Link
                                to={target}
                                aria-label={`Manage egress for ${env.name}`}
                              >
                                <IconChevronRight className="h-4 w-4" />
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
