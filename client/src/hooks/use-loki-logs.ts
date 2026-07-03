import { useQuery } from "@tanstack/react-query";
import { useState, useCallback, useMemo } from "react";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// --- Types ---

export interface LokiLabelsResponse {
  status: string;
  data: string[];
}

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][]; // [nanosecond_timestamp, log_line]
}

interface LokiQueryRangeResponse {
  status: string;
  data: {
    resultType: string;
    result: LokiStream[];
    stats?: Record<string, unknown>;
  };
}

export interface LogEntry {
  timestamp: number; // milliseconds
  timestampNano: string;
  line: string;
  labels: Record<string, string>;
}

// --- API functions ---

async function fetchLabelValues(label: string): Promise<LokiLabelsResponse> {
  // Raw Loki response shape ({status, data}) proxied straight through — not
  // Mini Infra's own envelope — so this stays unwrapped.
  return apiFetch<LokiLabelsResponse>(ApiRoute.monitoring.lokiLabelValues(label), {
    correlationIdPrefix: "loki",
    unwrap: false,
  });
}

async function fetchQueryRange(
  query: string,
  start: string,
  end: string,
  limit: number,
  direction: string,
): Promise<LokiQueryRangeResponse> {
  const url = new URL(ApiRoute.monitoring.lokiQueryRange(), window.location.origin);
  url.searchParams.set("query", query);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("direction", direction);
  // Raw Loki response shape — see `fetchLabelValues` above.
  return apiFetch<LokiQueryRangeResponse>(url.toString(), {
    correlationIdPrefix: "loki",
    unwrap: false,
  });
}

/**
 * Bare "lokiLogs" prefix for broad invalidation (e.g. a manual refresh
 * button). `queryKeys.loki` has no root/`all` key (see Phase 4 report) —
 * `logs()` always appends a second `query` element, so calling it with no
 * args here would produce `["lokiLogs", undefined]`, which fails TanStack's
 * partial-key match against the real (populated) query key built by
 * `useLokiLogs` below.
 */
export const LOKI_LOGS_PREFIX_KEY = ["lokiLogs"] as const;

// --- Helpers ---

function flattenStreams(
  result: LokiStream[],
  direction: string,
): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const stream of result) {
    for (const [nano, line] of stream.values) {
      entries.push({
        // Nanoseconds -> milliseconds: drop last 6 digits (safe for Number)
        timestamp: parseInt(nano.slice(0, -6), 10),
        timestampNano: nano,
        line,
        labels: stream.stream,
      });
    }
  }
  entries.sort((a, b) =>
    direction === "backward"
      ? b.timestamp - a.timestamp
      : a.timestamp - b.timestamp,
  );
  return entries;
}

// --- Hooks ---

export function useLokiServices(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: queryKeys.loki.labelValues("container"),
    queryFn: () => fetchLabelValues("container"),
    enabled,
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export interface LokiLogsQuery {
  services: string[];
  search: string;
  timeRangeSeconds: number;
  limit: number;
  direction: "backward" | "forward";
}

export function useLokiLogs(
  query: LokiLogsQuery,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const { enabled = true, refetchInterval = false } = options;

  const logqlQuery = useMemo(() => {
    let selector: string;
    if (query.services.length === 0) {
      selector = '{container=~".+"}';
    } else if (query.services.length === 1) {
      selector = `{container="${query.services[0]}"}`;
    } else {
      selector = `{container=~"${query.services.join("|")}"}`;
    }

    if (query.search.trim()) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      selector += ` |~ "(?i)${escaped}"`;
    }

    return selector;
  }, [query.services, query.search]);

  return useQuery({
    queryKey: queryKeys.loki.logs({
      logqlQuery,
      timeRangeSeconds: query.timeRangeSeconds,
      limit: query.limit,
      direction: query.direction,
    }),
    queryFn: () => {
      const now = Date.now();
      const startNano = ((now - query.timeRangeSeconds * 1000) * 1_000_000).toString();
      const endNano = (now * 1_000_000).toString();
      return fetchQueryRange(
        logqlQuery,
        startNano,
        endNano,
        query.limit,
        query.direction,
      );
    },
    enabled: enabled && !!logqlQuery,
    refetchInterval,
    staleTime: 5000,
    gcTime: 2 * 60 * 1000,
    retry: 1,
    select: (data) => ({
      entries: flattenStreams(data.data.result, query.direction),
      stats: data.data.stats,
    }),
  });
}

// --- Filter state ---

export type TimeRange = "5m" | "15m" | "1h" | "6h" | "24h";

export const TIME_RANGE_SECONDS: Record<TimeRange, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
};

export interface LogFiltersState {
  services: string[];
  timeRange: TimeRange;
  search: string;
  direction: "backward" | "forward";
  limit: number;
  tailing: boolean;
}

export function useLogFilters(initial: Partial<LogFiltersState> = {}) {
  const [filters, setFilters] = useState<LogFiltersState>({
    services: [],
    timeRange: "5m",
    search: "",
    direction: "backward",
    limit: 1000,
    tailing: false,
    ...initial,
  });

  const updateFilter = useCallback(
    <K extends keyof LogFiltersState>(key: K, value: LogFiltersState[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      services: [],
      timeRange: "5m",
      search: "",
      direction: "backward",
      limit: 1000,
      tailing: false,
      ...initial,
    });
  }, [initial]);

  return { filters, updateFilter, resetFilters };
}
