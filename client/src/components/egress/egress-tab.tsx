/**
 * Egress Firewall tab for the Environment Detail page.
 *
 * Renders three sections (top-to-bottom):
 *  1. Policy summary cards — one per stack, showing mode, defaultAction,
 *     version drift, and live gateway health.
 *  2. Rules section per policy — read-only table of rules (pattern, action,
 *     source, targets, hits, lastHit).
 *  3. Traffic feed — paginated EgressEvent table with filters and live prepend.
 *
 * This is the v1 read-only slice. Write actions (mode-toggle, rule CRUD)
 * require `egress:write` and will be added in the next slice.
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
} from "@tabler/icons-react";
import {
  useEgressPolicies,
  useEgressPolicy,
  useEgressGatewayHealth,
  useEgressEvents,
  useEgressEventFilters,
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
import { useFormattedDate } from "@/hooks/use-formatted-date";
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
// Mode badge
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
// Default action badge
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
// Policy card with embedded rules table
// ====================

interface PolicyCardProps {
  policy: EgressPolicySummary;
  environmentId: string;
}

function PolicyCard({ policy, environmentId }: PolicyCardProps) {
  const gatewayHealth = useEgressGatewayHealth(environmentId);

  const hasDrift =
    policy.appliedVersion !== null &&
    policy.version !== policy.appliedVersion;

  return (
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
            <ModeBadge mode={policy.mode} />
            <DefaultActionBadge action={policy.defaultAction} />
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
        <EmbeddedRulesTable policyId={policy.id} />

        {/* Next slice: Add rule-create/edit/delete buttons here (requires egress:write) */}
      </CardContent>
    </Card>
  );
}

// ====================
// Embedded rules table (read-only)
// ====================

function EmbeddedRulesTable({ policyId }: { policyId: string }) {
  const { formatRelativeTime, formatDateTime } = useFormattedDate();

  // useEgressPolicy is imported at the top of the file and cached by TanStack
  // Query — if a parent hook already fetched it, this is a free cache hit.
  const { data, isLoading, isError } = useEgressPolicy(policyId);
  const rules: EgressRuleSummary[] = data?.data?.rules ?? [];

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

  if (rules.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No rules defined yet.
      </p>
    );
  }

  return (
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={rule.id}>
              <TableCell className="font-mono text-xs">{rule.pattern}</TableCell>
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
              <TableCell className="text-right text-xs">{rule.hits}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {rule.lastHitAt ? (
                  <span title={formatDateTime(rule.lastHitAt)}>
                    {formatRelativeTime(rule.lastHitAt)}
                  </span>
                ) : (
                  <span className="italic">Never</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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

export function EgressTab({ environmentId }: EgressTabProps) {
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
