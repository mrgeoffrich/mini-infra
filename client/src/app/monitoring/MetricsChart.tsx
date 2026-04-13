import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { PrometheusQueryResult } from "@mini-infra/types";

interface MetricsChartProps {
  title: string;
  description: string;
  data?: PrometheusQueryResult;
  icon: React.ReactNode;
  valueFormatter: (value: number) => string;
  color: "blue" | "green" | "purple" | "orange";
}

const COLOR_MAP: Record<string, string> = {
  blue: "hsl(217, 91%, 60%)",
  green: "hsl(142, 71%, 45%)",
  purple: "hsl(262, 83%, 58%)",
  orange: "hsl(25, 95%, 53%)",
};

// Stable color palette for containers
const CONTAINER_COLORS = [
  "hsl(217, 91%, 60%)",
  "hsl(142, 71%, 45%)",
  "hsl(262, 83%, 58%)",
  "hsl(25, 95%, 53%)",
  "hsl(350, 89%, 60%)",
  "hsl(190, 90%, 50%)",
  "hsl(45, 93%, 47%)",
  "hsl(330, 81%, 60%)",
];

export function MetricsChart({
  title,
  description,
  data,
  icon,
  valueFormatter,
  color,
}: MetricsChartProps) {
  const { chartData, containerNames, chartConfig } = useMemo(() => {
    if (!data?.data?.result?.length) {
      return { chartData: [], containerNames: [] as string[], chartConfig: {} as ChartConfig };
    }

    const names = [...new Set(data.data.result.map(
      (r) => r.metric.container_name || r.metric.com_docker_compose_service || "unknown"
    ))];

    // Build time-series data keyed by timestamp
    const timeMap = new Map<number, Record<string, number>>();

    for (const result of data.data.result) {
      const name =
        result.metric.container_name ||
        result.metric.com_docker_compose_service ||
        "unknown";

      if (result.values) {
        for (const [timestamp, value] of result.values) {
          if (!timeMap.has(timestamp)) {
            timeMap.set(timestamp, { timestamp });
          }
          timeMap.get(timestamp)![name] = parseFloat(value);
        }
      }
    }

    const sorted = Array.from(timeMap.values()).sort(
      (a, b) => (a.timestamp as number) - (b.timestamp as number)
    );

    // Build chart config
    const config: ChartConfig = {};
    for (let i = 0; i < names.length; i++) {
      config[names[i]] = {
        label: names[i],
        color: names.length === 1 ? COLOR_MAP[color] : CONTAINER_COLORS[i % CONTAINER_COLORS.length],
      };
    }

    return { chartData: sorted, containerNames: names, chartConfig: config };
  }, [data, color]);

  if (!chartData.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
            No data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[250px] w-full">
          <AreaChart data={chartData}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={40}
              tickFormatter={(value) => {
                const date = new Date(value * 1000);
                return date.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={60}
              tickFormatter={valueFormatter}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_value, payload) => {
                    const timestamp = payload?.[0]?.payload?.timestamp;
                    if (!timestamp) return "Unknown";
                    const date = new Date(Number(timestamp) * 1000);
                    return date.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    });
                  }}
                  formatter={(value, name, item) => (
                    <div className="flex flex-1 items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-muted-foreground flex-1">
                        {name as string}
                      </span>
                      <span className="text-foreground font-mono font-medium tabular-nums">
                        {valueFormatter(Number(value))}
                      </span>
                    </div>
                  )}
                  hideIndicator
                />
              }
            />
            {containerNames.map((name) => (
              <Area
                key={name}
                dataKey={name}
                type="monotone"
                fill="transparent"
                stroke={chartConfig[name]?.color || COLOR_MAP[color]}
                strokeWidth={2}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
