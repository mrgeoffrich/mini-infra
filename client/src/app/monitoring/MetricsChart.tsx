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
import type { PrometheusQueryResponse } from "@/hooks/use-monitoring";

interface MetricsChartProps {
  title: string;
  description: string;
  data?: PrometheusQueryResponse;
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

    const names = data.data.result.map(
      (r) => r.metric.name || r.metric.container_label_com_docker_compose_service || "unknown"
    );

    // Build time-series data keyed by timestamp
    const timeMap = new Map<number, Record<string, number>>();

    for (const result of data.data.result) {
      const name =
        result.metric.name ||
        result.metric.container_label_com_docker_compose_service ||
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
            <defs>
              {containerNames.map((name, i) => (
                <linearGradient
                  key={name}
                  id={`fill-${title}-${i}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor={chartConfig[name]?.color || COLOR_MAP[color]}
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor={chartConfig[name]?.color || COLOR_MAP[color]}
                    stopOpacity={0.1}
                  />
                </linearGradient>
              ))}
            </defs>
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
                  labelFormatter={(value) => {
                    const date = new Date(Number(value) * 1000);
                    return date.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    });
                  }}
                  formatter={(value, name) => [
                    valueFormatter(Number(value)),
                    name,
                  ]}
                  indicator="dot"
                />
              }
            />
            {containerNames.map((name, i) => (
              <Area
                key={name}
                dataKey={name}
                type="monotone"
                fill={`url(#fill-${title}-${i})`}
                stroke={chartConfig[name]?.color || COLOR_MAP[color]}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
