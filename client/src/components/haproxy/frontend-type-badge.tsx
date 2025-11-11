import { Badge } from "@/components/ui/badge";
import { IconRocket, IconBrandDocker } from "@tabler/icons-react";

type FrontendType = 'deployment' | 'manual';

interface FrontendTypeBadgeProps {
  type: FrontendType;
  showIcon?: boolean;
  className?: string;
}

/**
 * Badge component to display the type of HAProxy frontend (Deployment or Manual)
 *
 * - Deployment: Blue badge with rocket icon - represents frontends managed by deployment configs
 * - Manual: Orange badge with Docker icon - represents manually connected container frontends
 */
export function FrontendTypeBadge({
  type,
  showIcon = true,
  className,
}: FrontendTypeBadgeProps) {
  const getTypeConfig = (type: FrontendType) => {
    switch (type) {
      case "deployment":
        return {
          label: "Deployment",
          icon: IconRocket,
          className: "text-blue-700 border-blue-200 bg-blue-50 dark:text-blue-300 dark:border-blue-800 dark:bg-blue-950",
        };
      case "manual":
        return {
          label: "Manual",
          icon: IconBrandDocker,
          className: "text-orange-700 border-orange-200 bg-orange-50 dark:text-orange-300 dark:border-orange-800 dark:bg-orange-950",
        };
    }
  };

  const config = getTypeConfig(type);
  const Icon = config.icon;

  return (
    <Badge
      variant="outline"
      className={`${config.className} ${className || ""}`}
    >
      {showIcon && <Icon className="w-3 h-3 mr-1" />}
      {config.label}
    </Badge>
  );
}
