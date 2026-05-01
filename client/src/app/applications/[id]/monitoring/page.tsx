import { useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  IconActivity,
  IconCpu,
  IconLoader2,
  IconServer,
  IconSettings,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useMonitoringStatus,
  usePrometheusRangeQuery,
} from "@/hooks/use-monitoring";
import { useLokiLogs } from "@/hooks/use-loki-logs";
import { formatCpu, formatBytes } from "@/lib/format-metrics";
import { MetricsChart } from "@/app/monitoring/MetricsChart";
import type { ApplicationDetailContext } from "../layout";

interface RangeOption {
  value: string;
  label: string;
  seconds: number;
  step: string;
}

const RANGES: RangeOption[] = [
  { value: "15m", label: "15m", seconds: 15 * 60, step: "15s" },
  { value: "1h", label: "1h", seconds: 60 * 60, step: "30s" },
  { value: "24h", label: "24h", seconds: 24 * 60 * 60, step: "300s" },
  { value: "7d", label: "7d", seconds: 7 * 24 * 60 * 60, step: "1800s" },
];

function escapeRegexAlt(values: string[]): string {
  return values
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function ApplicationMonitoringTab() {
  const { primaryStack, containerStatus } =
    useOutletContext<ApplicationDetailContext>();
  const [rangeValue, setRangeValue] = useState<string>("1h");
  const range =
    RANGES.find((r) => r.value === rangeValue) ?? RANGES[1];

  const { data: monitoringStatus, isLoading: monitoringLoading } =
    useMonitoringStatus();
  const monitoringRunning = monitoringStatus?.running === true;

  const containerNames = useMemo(
    () => containerStatus.map((c) => c.containerName).filter(Boolean),
    [containerStatus],
  );

  const namesRegex = useMemo(
    () => escapeRegexAlt(containerNames),
    [containerNames],
  );

  const cpuQuery = namesRegex
    ? `rate(docker_container_cpu_usage_total{container_name=~"${namesRegex}"}[5m]) / 1e9`
    : "";
  const memQuery = namesRegex
    ? `docker_container_mem_usage{container_name=~"${namesRegex}"}`
    : "";

  const enabled = monitoringRunning && containerNames.length > 0;

  const { data: cpuData, isLoading: cpuLoading } = usePrometheusRangeQuery(
    cpuQuery,
    range.seconds,
    range.step,
    { enabled },
  );
  const { data: memData, isLoading: memLoading } = usePrometheusRangeQuery(
    memQuery,
    range.seconds,
    range.step,
    { enabled },
  );

  const { data: logsData, isLoading: logsLoading } = useLokiLogs(
    {
      services: containerNames,
      search: "",
      timeRangeSeconds: Math.min(range.seconds, 60 * 60),
      limit: 200,
      direction: "backward",
    },
    { enabled, refetchInterval: 15000 },
  );

  if (!primaryStack) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Monitoring</CardTitle>
          <CardDescription>
            Metrics will appear here once this application is deployed.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (monitoringLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <IconLoader2 className="h-4 w-4 animate-spin" />
          Checking monitoring status…
        </CardContent>
      </Card>
    );
  }

  if (!monitoringRunning) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Monitoring is disabled</CardTitle>
          <CardDescription>
            Enable the monitoring stack to see CPU, memory, and log activity for
            this application.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link to="/monitoring">
              <IconSettings className="h-4 w-4 mr-2" />
              Open monitoring settings
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (containerNames.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No live containers</CardTitle>
          <CardDescription>
            Metrics are scoped to running containers. Start this application to
            begin collecting data.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            Showing metrics for {containerNames.length} container
            {containerNames.length === 1 ? "" : "s"}
          </div>
          <nav
            aria-label="Time range"
            className="bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]"
          >
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setRangeValue(r.value)}
                className={cn(
                  "inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                  rangeValue === r.value
                    ? "bg-background text-foreground shadow-sm dark:bg-input/30 dark:border-input dark:text-foreground"
                    : "text-foreground hover:text-foreground dark:text-muted-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </nav>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <MetricsChart
          title="CPU"
          description={`CPU cores used over ${range.label}`}
          icon={<IconCpu className="h-4 w-4" />}
          data={cpuData}
          valueFormatter={formatCpu}
          color="blue"
        />
        <MetricsChart
          title="Memory"
          description={`Memory in use over ${range.label}`}
          icon={<IconServer className="h-4 w-4" />}
          data={memData}
          valueFormatter={formatBytes}
          color="green"
        />
      </div>

      {(cpuLoading || memLoading) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <IconLoader2 className="h-4 w-4 animate-spin" />
          Loading metrics…
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconActivity className="h-4 w-4 text-muted-foreground" />
                Recent logs
              </CardTitle>
              <CardDescription>
                Last 200 lines from the application&apos;s containers (auto-refreshes every 15s).
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/logs">Open full log viewer</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <IconLoader2 className="h-4 w-4 animate-spin" />
              Loading logs…
            </div>
          ) : !logsData?.entries?.length ? (
            <p className="text-sm text-muted-foreground py-2">
              No log entries in the selected window.
            </p>
          ) : (
            <div className="rounded-md border bg-muted/30 max-h-96 overflow-auto">
              <ul className="font-mono text-xs divide-y">
                {logsData.entries.map((entry) => (
                  <li
                    key={`${entry.timestampNano}-${entry.line.slice(0, 32)}`}
                    className="flex gap-3 px-3 py-1.5"
                  >
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {formatLogTime(entry.timestamp)}
                    </span>
                    <span className="text-muted-foreground shrink-0 truncate max-w-[14rem]">
                      {entry.labels.container ?? entry.labels.service ?? ""}
                    </span>
                    <span className="whitespace-pre-wrap break-all">
                      {entry.line}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
