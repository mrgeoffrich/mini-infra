import { useState, useCallback, useMemo, useEffect } from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconAlertCircle,
  IconClock,
  IconRefresh,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  useEgressEvents,
  useEgressEventFilters,
  useEgressPolicies,
} from "@/hooks/use-egress";
import { useStack } from "@/hooks/use-stacks";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import type { EgressEventBroadcast } from "@mini-infra/types";

const ALL_VALUE = "__all__";

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

function TrafficFeedRow({
  event,
  formatRelativeTime,
  formatDateTime,
  showEnvironment,
  showStack,
  onAllow,
}: {
  event: EgressEventBroadcast;
  formatRelativeTime: (date: string) => string;
  formatDateTime: (date: string) => string;
  showEnvironment: boolean;
  showStack: boolean;
  onAllow?: (event: EgressEventBroadcast) => void;
}) {
  return (
    <TableRow>
      <TableCell className="text-xs whitespace-nowrap">
        <span title={formatDateTime(event.occurredAt)}>
          {formatRelativeTime(event.occurredAt)}
        </span>
      </TableCell>
      {showEnvironment && (
        <TableCell className="text-xs">
          <div
            className="truncate max-w-[140px]"
            title={event.environmentNameSnapshot}
          >
            {event.environmentNameSnapshot}
          </div>
        </TableCell>
      )}
      {showStack ? (
        <TableCell className="text-xs">
          <div
            className="truncate max-w-[140px]"
            title={event.stackNameSnapshot}
          >
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
      ) : (
        event.sourceServiceName && (
          <TableCell className="text-xs">
            <span
              className="text-muted-foreground font-mono truncate max-w-[140px] inline-block"
              title={event.sourceServiceName}
            >
              {event.sourceServiceName}
            </span>
          </TableCell>
        )
      )}
      {/* When showStack is false but no service name exists, render an empty
          cell to keep column counts consistent. */}
      {!showStack && !event.sourceServiceName && (
        <TableCell className="text-xs">
          <span className="text-muted-foreground italic">—</span>
        </TableCell>
      )}
      <TableCell className="font-mono text-xs truncate max-w-[200px]">
        {event.destination}
      </TableCell>
      <TableCell>
        <EventActionBadge action={event.action} />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[160px]">
        {event.matchedPattern ?? <span className="italic">none</span>}
      </TableCell>
      <TableCell className="text-xs text-right">{event.mergedHits}</TableCell>
      {onAllow && (
        <TableCell className="text-right">
          {event.action === "blocked" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => onAllow(event)}
              data-tour="egress-allow-blocked"
            >
              Allow
            </Button>
          ) : null}
        </TableCell>
      )}
    </TableRow>
  );
}

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

export interface EgressTrafficFeedProps {
  /** When undefined and policyId is also undefined, the feed shows events across every environment and adds an Environment column. */
  environmentId?: string;
  /**
   * Scope to a single policy (i.e. a single stack). When set:
   *  - the stack/service filter dropdowns are hidden (already implied by the policy)
   *  - the Stack column is hidden
   *  - stale stackId/sourceServiceName from useEgressEventFilters are NOT
   *    merged into the events query
   */
  policyId?: string;
  /**
   * Optional callback to render an inline "Allow" button on rows whose action
   * is "blocked". The detail page wires this to open EgressRuleDialog with
   * the destination + service pre-filled.
   */
  onAllowEvent?: (event: EgressEventBroadcast) => void;
}

export function EgressTrafficFeed({
  environmentId,
  policyId,
  onAllowEvent,
}: EgressTrafficFeedProps) {
  const { formatRelativeTime, formatDateTime } = useFormattedDate();

  const [timeRange, setTimeRange] = useState<string>("24h");
  const [destinationSearch, setDestinationSearch] = useState("");

  const { filters, updateFilter, resetFilters } = useEgressEventFilters();

  // When scoped to a policy, the stack and service filters are pre-implied —
  // hide their UI and never merge their (stale) state into the query.
  const isPolicyScoped = !!policyId;

  // Stack dropdown source — same query the parent Egress page already issues, so
  // TanStack Query dedupes by key (no extra HTTP request).
  const policiesQuery = useEgressPolicies({
    query: { environmentId, page: 1, limit: 200 },
    enabled: !isPolicyScoped,
  });

  // Service dropdown source — only enabled when a stack is selected.
  const stackQuery = useStack(filters.stackId ?? "");

  const stackOptions = useMemo(() => {
    const seen = new Map<string, string>(); // stackId -> stackName
    for (const p of policiesQuery.data?.policies ?? []) {
      if (p.stackId && !seen.has(p.stackId)) {
        seen.set(p.stackId, p.stackNameSnapshot);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [policiesQuery.data?.policies]);

  const serviceOptions = useMemo(
    () => (stackQuery.data?.data?.services ?? []).map((s) => s.serviceName),
    [stackQuery.data?.data?.services],
  );

  // Switching environments invalidates any stack/service filter (a stack from
  // another env wouldn't match anything). The stack→service cascade is handled
  // inline in the Stack dropdown's onValueChange so both updates batch into a
  // single render — no wasted fetch with a stale service filter.
  // updateFilter resets page to 1 on every call, so pagination is implicit.
  useEffect(() => {
    updateFilter("stackId", undefined);
    updateFilter("sourceServiceName", undefined);
  }, [environmentId, updateFilter]);

  const query = useMemo(
    () => ({
      environmentId,
      policyId,
      // Skip stack/service filters when policy-scoped — the stale filter state
      // belongs to a different view and would over-narrow the result set.
      stackId: isPolicyScoped ? undefined : filters.stackId,
      sourceServiceName: isPolicyScoped ? undefined : filters.sourceServiceName,
      action: filters.action,
      since: sinceFromRange(timeRange),
      page: filters.page,
      limit: filters.limit,
    }),
    [
      environmentId,
      policyId,
      isPolicyScoped,
      filters.stackId,
      filters.sourceServiceName,
      filters.action,
      timeRange,
      filters.page,
      filters.limit,
    ],
  );

  const { data, isLoading, isError, error, liveEvents } = useEgressEvents({
    query,
  });

  const showEnvironment = !environmentId && !isPolicyScoped;
  const showStack = !isPolicyScoped;

  const historyEvents = data?.events ?? [];
  const totalPages = data?.totalPages ?? 1;

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
  // Columns: Time + (Environment?) + Stack/Service + Destination + Action +
  // Matched + Hits + (Actions?) — Stack/Service is always one cell whose
  // content differs based on `showStack`.
  const colCount =
    1 +
    (showEnvironment ? 1 : 0) +
    1 +
    1 +
    1 +
    1 +
    1 +
    (onAllowEvent ? 1 : 0);

  const handlePreviousPage = useCallback(() => {
    if (filters.page > 1) updateFilter("page", filters.page - 1);
  }, [filters.page, updateFilter]);

  const handleNextPage = useCallback(() => {
    if (filters.page < totalPages) updateFilter("page", filters.page + 1);
  }, [filters.page, totalPages, updateFilter]);

  return (
    <div className="space-y-4">
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

        {!isPolicyScoped && stackOptions.length > 0 && (
          <Select
            value={filters.stackId ?? ALL_VALUE}
            onValueChange={(v) => {
              updateFilter("stackId", v === ALL_VALUE ? undefined : v);
              // Service names aren't unique across stacks, so clear the service
              // filter whenever the stack selection changes.
              updateFilter("sourceServiceName", undefined);
            }}
            disabled={policiesQuery.isLoading}
          >
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue placeholder="Stack" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All stacks</SelectItem>
              {stackOptions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {!isPolicyScoped && filters.stackId && (
          <Select
            value={filters.sourceServiceName ?? ALL_VALUE}
            onValueChange={(v) =>
              updateFilter("sourceServiceName", v === ALL_VALUE ? undefined : v)
            }
            disabled={stackQuery.isLoading}
          >
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue placeholder="Service" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All services</SelectItem>
              {serviceOptions.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground italic">
                  No services found
                </div>
              ) : (
                serviceOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        )}

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

      {data && (
        <div className="text-xs text-muted-foreground">
          {hasLive && (
            <span className="text-blue-600 dark:text-blue-400 mr-2">
              {filteredLive.length} new live
            </span>
          )}
          Showing {(data.page - 1) * data.limit + 1}–
          {Math.min(data.page * data.limit, data.total)} of {data.total} events
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load traffic events:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      )}

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
              {showEnvironment && (
                <TableHead className="text-xs">Environment</TableHead>
              )}
              <TableHead className="text-xs">
                {showStack ? "Stack / Service" : "Service"}
              </TableHead>
              <TableHead className="text-xs">Destination</TableHead>
              <TableHead className="text-xs">Action</TableHead>
              <TableHead className="text-xs">Matched Pattern</TableHead>
              <TableHead className="text-xs text-right">Hits</TableHead>
              {onAllowEvent && (
                <TableHead className="text-xs text-right">Actions</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: colCount }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <>
                {filteredLive.map((event) => (
                  <TrafficFeedRow
                    key={`live-${event.id}`}
                    event={event}
                    formatRelativeTime={formatRelativeTime}
                    formatDateTime={formatDateTime}
                    showEnvironment={showEnvironment}
                    showStack={showStack}
                    onAllow={onAllowEvent}
                  />
                ))}

                {displayHistory.map((event) => (
                  <TrafficFeedRow
                    key={event.id}
                    event={event}
                    formatRelativeTime={formatRelativeTime}
                    formatDateTime={formatDateTime}
                    showEnvironment={showEnvironment}
                    showStack={showStack}
                    onAllow={onAllowEvent}
                  />
                ))}

                {filteredLive.length === 0 && displayHistory.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={colCount}
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

      {data && data.total > data.limit && (
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
