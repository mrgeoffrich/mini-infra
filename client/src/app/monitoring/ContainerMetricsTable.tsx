import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PrometheusQueryResult } from "@mini-infra/types";
import { formatCpu, formatBytes } from "@/lib/format-metrics";

interface ContainerMetricsTableProps {
  cpuData?: PrometheusQueryResult;
  memoryData?: PrometheusQueryResult;
}

interface ContainerMetric {
  name: string;
  cpu: number;
  memory: number;
}

export function ContainerMetricsTable({
  cpuData,
  memoryData,
}: ContainerMetricsTableProps) {
  const metrics = mergeMetrics(cpuData, memoryData);

  if (metrics.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Container Metrics</CardTitle>
          <CardDescription>
            Waiting for metrics data from Prometheus...
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Sort by CPU usage descending
  const sorted = [...metrics].sort((a, b) => b.cpu - a.cpu);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Container Metrics</CardTitle>
        <CardDescription>
          Current CPU and memory usage per container
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Container</TableHead>
              <TableHead className="text-right">CPU Usage</TableHead>
              <TableHead className="text-right">Memory</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((metric) => (
              <TableRow key={metric.name}>
                <TableCell className="font-medium">{metric.name}</TableCell>
                <TableCell className="text-right">
                  {formatCpu(metric.cpu)}
                </TableCell>
                <TableCell className="text-right">
                  {formatBytes(metric.memory)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function mergeMetrics(
  cpuData?: PrometheusQueryResult,
  memoryData?: PrometheusQueryResult
): ContainerMetric[] {
  const metricsMap = new Map<string, ContainerMetric>();

  if (cpuData?.data?.result) {
    for (const result of cpuData.data.result) {
      const name = result.metric.container_name || result.metric.com_docker_compose_service || "unknown";
      const value = result.value ? parseFloat(result.value[1]) : 0;
      metricsMap.set(name, { name, cpu: value, memory: 0 });
    }
  }

  if (memoryData?.data?.result) {
    for (const result of memoryData.data.result) {
      const name = result.metric.container_name || result.metric.com_docker_compose_service || "unknown";
      const value = result.value ? parseFloat(result.value[1]) : 0;
      const existing = metricsMap.get(name);
      if (existing) {
        existing.memory = value;
      } else {
        metricsMap.set(name, { name, cpu: 0, memory: value });
      }
    }
  }

  return Array.from(metricsMap.values());
}
