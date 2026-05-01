import {
  IconActivity,
  IconArrowsShuffle,
  IconClock,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  StackContainerStatus,
  StackInfo,
  StackServiceDefinition,
} from "@mini-infra/types";

interface StatusStripProps {
  stack: StackInfo | null;
  containerStatus: StackContainerStatus[];
}

interface StatItem {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "default" | "success" | "warning" | "destructive" | "muted";
}

function getServices(stack: StackInfo | null): StackServiceDefinition[] {
  return stack?.lastAppliedSnapshot?.services ?? [];
}

function countRunningContainers(
  status: StackContainerStatus[],
): number {
  return status.filter((c) => c.state === "running").length;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const TONE_CLASS: Record<StatItem["tone"], string> = {
  default: "text-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

export function StatusStrip({ stack, containerStatus }: StatusStripProps) {
  const services = getServices(stack);
  const total = services.length;
  const running = countRunningContainers(containerStatus);

  const servicesItem: StatItem = {
    icon: IconActivity,
    label: "Services",
    value: total === 0 ? "—" : `${running}/${total} up`,
    tone:
      total === 0
        ? "muted"
        : running === total
          ? "success"
          : running === 0
            ? "destructive"
            : "warning",
  };

  const statusItem: StatItem = {
    icon: IconArrowsShuffle,
    label: "Stack",
    value: stack?.status ?? "not deployed",
    tone:
      stack?.status === "synced"
        ? "success"
        : stack?.status === "drifted"
          ? "warning"
          : stack?.status === "error"
            ? "destructive"
            : "muted",
  };

  const routingHosts = [
    ...(stack?.tunnelIngress ?? []).map((t) => t.fqdn),
    ...(stack?.dnsRecords ?? []).map((d) => d.fqdn),
  ];
  const tlsCount = stack?.tlsCertificates?.length ?? 0;
  const routingItem: StatItem = {
    icon: IconShieldCheck,
    label: "Routing",
    value:
      routingHosts.length === 0
        ? "none"
        : `${routingHosts.length} host${routingHosts.length === 1 ? "" : "s"}${tlsCount > 0 ? " · TLS" : ""}`,
    tone: routingHosts.length === 0 ? "muted" : "default",
  };

  const lastAppliedItem: StatItem = {
    icon: IconClock,
    label: "Last applied",
    value: formatRelative(stack?.lastAppliedAt ?? null),
    tone: stack?.lastAppliedAt ? "default" : "muted",
  };

  const items: StatItem[] = [
    servicesItem,
    statusItem,
    routingItem,
    lastAppliedItem,
  ];

  return (
    <Card>
      <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="flex items-start gap-3">
              <Icon
                className={cn("h-5 w-5 mt-0.5 shrink-0", TONE_CLASS[item.tone])}
              />
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">
                  {item.label}
                </div>
                <div
                  className={cn("text-sm font-medium", TONE_CLASS[item.tone])}
                >
                  {item.value}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
