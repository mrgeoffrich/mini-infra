import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ContainerStatus } from "@mini-infra/types";

interface ContainerStatusBadgeProps {
  status: ContainerStatus;
  className?: string;
}

export const ContainerStatusBadge = React.memo(function ContainerStatusBadge({
  status,
  className,
}: ContainerStatusBadgeProps) {
  const config = React.useMemo(() => {
    switch (status) {
      case "running":
        return {
          variant: "default" as const,
          className: "bg-green-100 text-green-800 hover:bg-green-100",
          label: "Running",
        };
      case "stopped":
        return {
          variant: "secondary" as const,
          className: "bg-gray-100 text-gray-800 hover:bg-gray-100",
          label: "Stopped",
        };
      case "exited":
        return {
          variant: "destructive" as const,
          className: "bg-red-100 text-red-800 hover:bg-red-100",
          label: "Exited",
        };
      case "paused":
        return {
          variant: "outline" as const,
          className: "bg-yellow-100 text-yellow-800 hover:bg-yellow-100",
          label: "Paused",
        };
      case "restarting":
        return {
          variant: "outline" as const,
          className: "bg-blue-100 text-blue-800 hover:bg-blue-100",
          label: "Restarting",
        };
      default:
        return {
          variant: "outline" as const,
          className: "bg-gray-100 text-gray-800 hover:bg-gray-100",
          label: status,
        };
    }
  }, [status]);

  return (
    <Badge variant={config.variant} className={cn(config.className, className)}>
      <span className="flex items-center gap-1">
        <span
          className={cn(
            "w-2 h-2 rounded-full",
            status === "running" && "bg-green-500",
            status === "stopped" && "bg-gray-500",
            status === "exited" && "bg-red-500",
            status === "paused" && "bg-yellow-500",
            status === "restarting" && "bg-blue-500",
          )}
        />
        {config.label}
      </span>
    </Badge>
  );
});
