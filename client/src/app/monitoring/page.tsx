import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import {
  IconActivity,
  IconAlertCircle,
  IconCircleCheck,
  IconCircleX,
  IconCpu,
  IconLoader2,
  IconNetwork,
  IconPlayerPlay,
  IconPlayerStop,
  IconServer,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useMonitoringStatus,
  useStartMonitoring,
  useStopMonitoring,
  useForceRemoveMonitoring,
  usePrometheusQuery,
  usePrometheusRangeQuery,
} from "@/hooks/use-monitoring";
import { formatCpu, formatBytes, formatBytesPerSec } from "@/lib/format-metrics";
import { MetricsChart } from "./MetricsChart";
import { ContainerMetricsTable } from "./ContainerMetricsTable";

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
    isLoading: statusLoading,
    error: statusError,
  } = useMonitoringStatus();

  const startMonitoring = useStartMonitoring();
  const stopMonitoring = useStopMonitoring();
  const forceRemove = useForceRemoveMonitoring();

  const isRunning = status?.service?.status === "running";
  const isStopped =
    status?.service?.status === "stopped" ||
    status?.service?.status === "failed" ||
    !status?.service;

  const rangeSeconds = TIME_RANGE_SECONDS[timeRange];
  const step = TIME_RANGE_STEP[timeRange];

  // Current metrics (instant queries)
  const { data: cpuData } = usePrometheusQuery(
    'rate(docker_container_cpu_usage_total{container_name!=""}[5m]) / 1e9',
    { enabled: isRunning }
  );

  const { data: memoryData } = usePrometheusQuery(
    'docker_container_mem_usage{container_name!=""}',
    { enabled: isRunning }
  );

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

  const handleStart = async () => {
    try {
      await startMonitoring.mutateAsync();
      toast.success("Monitoring service started successfully");
    } catch (error) {
      toast.error(
        `Failed to start monitoring: ${(error as Error).message}`
      );
    }
  };

  const handleStop = async () => {
    try {
      await stopMonitoring.mutateAsync();
      toast.success("Monitoring service stopped");
    } catch (error) {
      toast.error(
        `Failed to stop monitoring: ${(error as Error).message}`
      );
    }
  };

  const handleForceRemove = async () => {
    try {
      const result = await forceRemove.mutateAsync();
      if (result.removed.length > 0) {
        toast.success(`Force removed ${result.removed.length} container(s)`);
      } else {
        toast.info("No monitoring containers found to remove");
      }
      if (result.errors.length > 0) {
        toast.warning(`Some containers had errors: ${result.errors.join(", ")}`);
      }
    } catch (error) {
      toast.error(
        `Failed to force remove: ${(error as Error).message}`
      );
    }
  };

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
        {/* Service Status Card */}
        <MonitoringServiceCard
          status={status}
          isLoading={statusLoading}
          isRunning={isRunning}
          isStopped={isStopped}
          isStarting={startMonitoring.isPending}
          isStopping={stopMonitoring.isPending}
          isForceRemoving={forceRemove.isPending}
          onStart={handleStart}
          onStop={handleStop}
          onForceRemove={handleForceRemove}
        />

        {/* Metrics Content */}
        {isRunning && (
          <div className="mt-6 space-y-6">
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

            {/* Current Metrics Table */}
            <ContainerMetricsTable
              cpuData={cpuData}
              memoryData={memoryData}
            />

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

function MonitoringServiceCard({
  status,
  isLoading,
  isRunning,
  isStopped,
  isStarting,
  isStopping,
  isForceRemoving,
  onStart,
  onStop,
  onForceRemove,
}: {
  status: ReturnType<typeof useMonitoringStatus>["data"];
  isLoading: boolean;
  isRunning: boolean;
  isStopped: boolean;
  isStarting: boolean;
  isStopping: boolean;
  isForceRemoving: boolean;
  onStart: () => void;
  onStop: () => void;
  onForceRemove: () => void;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-32" />
        </CardContent>
      </Card>
    );
  }

  const serviceStatus = status?.service?.status || "unknown";
  const healthMessage = status?.healthDetails?.message;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Monitoring Service
              <StatusBadge status={serviceStatus} />
            </CardTitle>
            <CardDescription>
              {healthMessage || "Telegraf + Prometheus container metrics collection"}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {isStopped && (
              <Button
                onClick={onStart}
                disabled={isStarting}
                className="bg-green-600 hover:bg-green-700"
              >
                {isStarting ? (
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <IconPlayerPlay className="mr-2 h-4 w-4" />
                )}
                Start Monitoring
              </Button>
            )}
            {isRunning && (
              <Button
                onClick={onStop}
                disabled={isStopping}
                variant="destructive"
              >
                {isStopping ? (
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <IconPlayerStop className="mr-2 h-4 w-4" />
                )}
                Stop
              </Button>
            )}
            <Button
              onClick={onForceRemove}
              disabled={isForceRemoving}
              variant="outline"
              size="icon"
              title="Force remove all monitoring containers"
            >
              {isForceRemoving ? (
                <IconLoader2 className="h-4 w-4 animate-spin" />
              ) : (
                <IconTrash className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      {status?.lastError && (
        <CardContent>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {typeof status.lastError === "object" && "message" in status.lastError
                ? (status.lastError as { message: string }).message
                : "An error occurred"}
            </AlertDescription>
          </Alert>
        </CardContent>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "running":
      return (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
          <IconCircleCheck className="mr-1 h-3 w-3" />
          Running
        </Badge>
      );
    case "stopped":
      return (
        <Badge variant="secondary">
          <IconCircleX className="mr-1 h-3 w-3" />
          Stopped
        </Badge>
      );
    case "starting":
      return (
        <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
          <IconLoader2 className="mr-1 h-3 w-3 animate-spin" />
          Starting
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <IconAlertCircle className="mr-1 h-3 w-3" />
          Failed
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default MonitoringPage;
