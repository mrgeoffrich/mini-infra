import { IconCheck, IconX, IconLoader2, IconClock, IconBan } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import type { AgentSidecarTaskStatus } from "@mini-infra/types";

const statusConfig: Record<
  AgentSidecarTaskStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className: string; icon: React.ReactNode }
> = {
  running: {
    label: "Running",
    variant: "default",
    className: "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    icon: <IconLoader2 className="h-3 w-3 animate-spin" />,
  },
  completed: {
    label: "Completed",
    variant: "default",
    className: "border-green-500 bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    icon: <IconCheck className="h-3 w-3" />,
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    className: "",
    icon: <IconX className="h-3 w-3" />,
  },
  cancelled: {
    label: "Cancelled",
    variant: "outline",
    className: "",
    icon: <IconBan className="h-3 w-3" />,
  },
  timeout: {
    label: "Timeout",
    variant: "destructive",
    className: "border-orange-500 bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    icon: <IconClock className="h-3 w-3" />,
  },
};

export function TaskStatusBadge({ status }: { status: AgentSidecarTaskStatus }) {
  const config = statusConfig[status];
  return (
    <Badge variant={config.variant} className={config.className}>
      {config.icon}
      <span className="ml-1">{config.label}</span>
    </Badge>
  );
}
