/**
 * Stack-centric main view for /egress.
 *
 * One row per EgressPolicy (1:1 with stack). Filters: env, mode, free-text
 * stack-name search. URL state via ?env=, ?mode=, ?q= so the view is
 * deep-linkable. Clicking a row navigates to /egress/:policyId.
 */

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  IconAlertCircle,
  IconShield,
  IconChevronRight,
  IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEgressPolicies, useEgressGatewayHealth } from "@/hooks/use-egress";
import { useEnvironments } from "@/hooks/use-environments";
import {
  ModeBadge,
  DefaultActionBadge,
  GatewayHealthBadge,
} from "./egress-policy-controls";
import type { EgressPolicySummary } from "@mini-infra/types";

const ALL_VALUE = "__all__";

/**
 * Per-row gateway health indicator. Subscribes to the env's health stream.
 * Mounted as its own component so each row's socket subscription is isolated.
 */
function PolicyHealthCell({ environmentId }: { environmentId: string | null }) {
  const health = useEgressGatewayHealth(environmentId);
  return <GatewayHealthBadge health={health} />;
}

interface PolicyRowProps {
  policy: EgressPolicySummary;
}

function PolicyRow({ policy }: PolicyRowProps) {
  const detailPath = `/egress/${policy.id}`;
  return (
    <TableRow className="hover:bg-muted/40 cursor-pointer">
      <TableCell className="font-medium">
        <Link
          to={detailPath}
          className="flex items-center gap-2 hover:underline"
          data-tour="egress-stack-row"
        >
          <IconShield className="h-4 w-4 text-muted-foreground" />
          {policy.stackNameSnapshot}
        </Link>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {policy.environmentNameSnapshot}
      </TableCell>
      <TableCell>
        <ModeBadge mode={policy.mode} />
      </TableCell>
      <TableCell>
        <DefaultActionBadge action={policy.defaultAction} />
      </TableCell>
      <TableCell>
        <PolicyHealthCell environmentId={policy.environmentId} />
      </TableCell>
      <TableCell className="w-10 text-right">
        <Link
          to={detailPath}
          className="inline-flex items-center text-muted-foreground hover:text-foreground"
          aria-label={`Open ${policy.stackNameSnapshot}`}
        >
          <IconChevronRight className="h-4 w-4" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

export function EgressStacksTable() {
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env") ?? ALL_VALUE;
  const modeParam = searchParams.get("mode") ?? ALL_VALUE;
  const qParam = searchParams.get("q") ?? "";

  const envQuery = useEnvironments({ filters: { page: 1, limit: 100 } });
  const policiesQuery = useEgressPolicies({
    query: { page: 1, limit: 200 },
  });

  const environments = envQuery.data?.environments ?? [];
  const policies = useMemo(
    () => policiesQuery.data?.policies ?? [],
    [policiesQuery.data?.policies],
  );

  const filteredPolicies = useMemo(() => {
    return policies.filter((p) => {
      if (envParam !== ALL_VALUE && p.environmentId !== envParam) return false;
      if (modeParam !== ALL_VALUE && p.mode !== modeParam) return false;
      if (qParam) {
        const q = qParam.toLowerCase();
        if (!p.stackNameSnapshot.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [policies, envParam, modeParam, qParam]);

  const updateParam = (key: string, value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === ALL_VALUE || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  };

  const resetFilters = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("env");
      next.delete("mode");
      next.delete("q");
      return next;
    });
  };

  const hasFilters =
    envParam !== ALL_VALUE || modeParam !== ALL_VALUE || qParam !== "";

  const isLoading = policiesQuery.isLoading;
  const error = policiesQuery.error;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="h-8 text-xs w-56"
          placeholder="Search stack name..."
          value={qParam}
          onChange={(e) => updateParam("q", e.target.value)}
        />

        <Select
          value={envParam}
          onValueChange={(v) => updateParam("env", v)}
          disabled={envQuery.isLoading}
        >
          <SelectTrigger className="w-44 h-8 text-xs">
            <SelectValue placeholder="Environment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All environments</SelectItem>
            {environments.map((env) => (
              <SelectItem key={env.id} value={env.id}>
                {env.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={modeParam}
          onValueChange={(v) => updateParam("mode", v)}
        >
          <SelectTrigger className="w-32 h-8 text-xs">
            <SelectValue placeholder="Mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All modes</SelectItem>
            <SelectItem value="detect">Detect</SelectItem>
            <SelectItem value="enforce">Enforce</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            className="h-8 text-xs"
          >
            <IconRefresh className="h-3 w-3 mr-1" />
            Reset
          </Button>
        )}

        <div className="ml-auto text-xs text-muted-foreground">
          {!isLoading && (
            <>
              {filteredPolicies.length}
              {hasFilters && ` of ${policies.length}`} stack
              {policies.length === 1 ? "" : "s"}
            </>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load stacks:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stack</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Default Action</TableHead>
              <TableHead>Gateway</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : filteredPolicies.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground text-sm"
                >
                  {hasFilters ? (
                    <>No stacks match the current filters.</>
                  ) : policies.length === 0 ? (
                    <div className="space-y-1">
                      <p className="font-medium">No egress policies yet</p>
                      <p className="text-xs">
                        Policies are created automatically when you deploy a
                        stack into an environment.
                      </p>
                    </div>
                  ) : (
                    <>No stacks match the current filters.</>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filteredPolicies.map((policy) => (
                <PolicyRow key={policy.id} policy={policy} />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {!isLoading && policies.length > 0 && (
        <p className="text-xs text-muted-foreground italic">
          {policies.length === 1 ? "1 stack" : `${policies.length} stacks`}.
          Click a row to view its rules and traffic.
        </p>
      )}

      {/* Optional helper for empty environments */}
      {!isLoading && environments.length > 0 && policies.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          <Badge variant="outline" className="mr-1 text-xs">
            Tip
          </Badge>
          System stacks (haproxy, egress-gateway) are intentionally omitted from
          this view.
        </p>
      )}
    </div>
  );
}
