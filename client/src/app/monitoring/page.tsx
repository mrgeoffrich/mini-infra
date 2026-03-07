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
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useMonitoringStatus,
  useMonitoringPlan,
  useApplyMonitoring,
  useStopMonitoring,
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

  const stackId = status?.stack?.id;
  const isRunning = status?.running === true;
  const isStopped = !isRunning;
  const stackStatus = status?.stack?.status;

  const applyMonitoring = useApplyMonitoring();
  const stopMonitoring = useStopMonitoring();

  const {
    data: planData,
    isLoading: planLoading,
  } = useMonitoringPlan(stackId, !!stackId && isStopped);

  const plan = planData?.data;

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

  const handleDeploy = async () => {
    if (!stackId) return;
    try {
      await applyMonitoring.mutateAsync(stackId);
      toast.success("Monitoring stack deployed successfully");
    } catch (error) {
      toast.error(
        `Failed to deploy monitoring: ${(error as Error).message}`
      );
    }
  };

  const handleStop = async () => {
    try {
      await stopMonitoring.mutateAsync();
      toast.success("Monitoring stack stopped");
    } catch (error) {
      toast.error(
        `Failed to stop monitoring: ${(error as Error).message}`
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
          stackStatus={stackStatus}
          isDeploying={applyMonitoring.isPending}
          isStopping={stopMonitoring.isPending}
          plan={plan}
          planLoading={planLoading}
          onDeploy={handleDeploy}
          onStop={handleStop}
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
  stackStatus,
  isDeploying,
  isStopping,
  plan,
  planLoading,
  onDeploy,
  onStop,
}: {
  status: ReturnType<typeof useMonitoringStatus>["data"];
  isLoading: boolean;
  isRunning: boolean;
  isStopped: boolean;
  stackStatus: string | undefined;
  isDeploying: boolean;
  isStopping: boolean;
  plan: any;
  planLoading: boolean;
  onDeploy: () => void;
  onStop: () => void;
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

  if (!status?.stack) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Monitoring Service
            <Badge variant="secondary">
              <IconCircleX className="mr-1 h-3 w-3" />
              Not Configured
            </Badge>
          </CardTitle>
          <CardDescription>
            {status?.message || "Monitoring stack will be created on next server restart."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Monitoring Service
              <StatusBadge running={isRunning} stackStatus={stackStatus} />
            </CardTitle>
            <CardDescription>
              Telegraf + Prometheus container metrics and Loki + Alloy log collection
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {isStopped && (
              <Button
                onClick={onDeploy}
                disabled={isDeploying || planLoading}
                className="bg-green-600 hover:bg-green-700"
              >
                {isDeploying ? (
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <IconPlayerPlay className="mr-2 h-4 w-4" />
                )}
                {stackStatus === "undeployed" ? "Deploy" : "Redeploy"}
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
          </div>
        </div>
      </CardHeader>
      {isStopped && plan?.hasChanges && (
        <CardContent>
          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-2">Plan: {plan.actions.length} service(s)</p>
            <ul className="space-y-1">
              {plan.actions.map((action: any) => (
                <li key={action.serviceName} className="flex items-center gap-2">
                  <Badge
                    variant={action.action === "create" ? "default" : action.action === "recreate" ? "secondary" : "destructive"}
                    className="text-xs"
                  >
                    {action.action}
                  </Badge>
                  <span>{action.serviceName}</span>
                  {action.desiredImage && (
                    <span className="text-xs text-muted-foreground">({action.desiredImage})</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function StatusBadge({ running, stackStatus }: { running: boolean; stackStatus: string | undefined }) {
  if (running) {
    return (
      <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
        <IconCircleCheck className="mr-1 h-3 w-3" />
        Running
      </Badge>
    );
  }

  switch (stackStatus) {
    case "undeployed":
      return (
        <Badge variant="secondary">
          <IconCircleX className="mr-1 h-3 w-3" />
          Undeployed
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <IconAlertCircle className="mr-1 h-3 w-3" />
          Error
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">
          <IconCircleX className="mr-1 h-3 w-3" />
          Stopped
        </Badge>
      );
  }
}

export default MonitoringPage;
