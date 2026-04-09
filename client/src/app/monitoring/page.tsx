import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconActivity,
  IconAlertCircle,
  IconCpu,
  IconNetwork,
  IconServer,
} from "@tabler/icons-react";
import {
  useMonitoringStatus,
  usePrometheusRangeQuery,
} from "@/hooks/use-monitoring";
import { formatCpu, formatBytes, formatBytesPerSec } from "@/lib/format-metrics";
import { MetricsChart } from "./MetricsChart";

type TimeRange = "15m" | "1h" | "6h" | "24h";

const TIME_RANGE_SECONDS: Record<TimeRange, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
};

const TIME_RANGE_STEP: Record<TimeRange, string> = {
  "15m": "15s",
  "1h": "60s",
  "6h": "300s",
  "24h": "600s",
};

export function MonitoringPage() {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const {
    data: status,
    error: statusError,
  } = useMonitoringStatus();

  const isRunning = status?.running === true;

  const rangeSeconds = TIME_RANGE_SECONDS[timeRange];
  const step = TIME_RANGE_STEP[timeRange];

  // Range queries for charts
  const { data: cpuRangeData } = usePrometheusRangeQuery(
    'rate(docker_container_cpu_usage_total{container_name!=""}[5m]) / 1e9',
    rangeSeconds,
    step,
    { enabled: isRunning }
  );

  const { data: memoryRangeData } = usePrometheusRangeQuery(
    'docker_container_mem_usage{container_name!=""}',
    rangeSeconds,
    step,
    { enabled: isRunning }
  );

  const { data: networkRxRangeData } = usePrometheusRangeQuery(
    'rate(docker_container_net_rx_bytes{container_name!=""}[5m])',
    rangeSeconds,
    step,
    { enabled: isRunning }
  );

  const { data: networkTxRangeData } = usePrometheusRangeQuery(
    'rate(docker_container_net_tx_bytes{container_name!=""}[5m])',
    rangeSeconds,
    step,
    { enabled: isRunning }
  );

  if (statusError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <PageHeader />
          <Alert variant="destructive" className="mt-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load monitoring status: {statusError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <PageHeader />
      </div>

      <div className="px-4 lg:px-6">
        {!isRunning && (
          <p className="text-sm text-muted-foreground">
            Monitoring is not currently running. Deploy the monitoring stack from the Host page to view container metrics.
          </p>
        )}

        {isRunning && (
          <div className="space-y-6">
            {/* Time Range Selector */}
            <div className="flex justify-end">
              <Select
                value={timeRange}
                onValueChange={(v) => setTimeRange(v as TimeRange)}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15m">Last 15 minutes</SelectItem>
                  <SelectItem value="1h">Last 1 hour</SelectItem>
                  <SelectItem value="6h">Last 6 hours</SelectItem>
                  <SelectItem value="24h">Last 24 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <MetricsChart
                title="CPU Usage"
                description="CPU usage rate per container"
                data={cpuRangeData}
                icon={<IconCpu className="h-4 w-4" />}
                valueFormatter={formatCpu}
                color="blue"
              />
              <MetricsChart
                title="Memory Usage"
                description="Working set memory per container"
                data={memoryRangeData}
                icon={<IconServer className="h-4 w-4" />}
                valueFormatter={formatBytes}
                color="green"
              />
              <MetricsChart
                title="Network Receive"
                description="Inbound network traffic rate"
                data={networkRxRangeData}
                icon={<IconNetwork className="h-4 w-4" />}
                valueFormatter={formatBytesPerSec}
                color="purple"
              />
              <MetricsChart
                title="Network Transmit"
                description="Outbound network traffic rate"
                data={networkTxRangeData}
                icon={<IconNetwork className="h-4 w-4" />}
                valueFormatter={formatBytesPerSec}
                color="orange"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
        <IconActivity className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-3xl font-bold">Container Metrics</h1>
        <p className="text-muted-foreground">
          Monitor CPU, memory, and network usage across all containers
        </p>
      </div>
    </div>
  );
}

export default MonitoringPage;
