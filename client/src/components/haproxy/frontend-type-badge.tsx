import { Badge } from "@/components/ui/badge";
import { IconRocket, IconBrandDocker, IconRoute } from "@tabler/icons-react";
import type { FrontendType } from "@mini-infra/types";

interface FrontendTypeBadgeProps {
  type: FrontendType | string;
  isSharedFrontend?: boolean;
  showIcon?: boolean;
  className?: string;
}

/**
 * Badge component to display the type of HAProxy frontend (Deployment, Manual, or Shared)
 *
 * - Deployment: Blue badge with rocket icon - represents frontends managed by deployment configs
 * - Manual: Orange badge with Docker icon - represents manually connected container frontends
 * - Shared: Purple badge with route icon - represents shared frontends with multiple routes
 */
export function FrontendTypeBadge({
  type,
  isSharedFrontend,
  showIcon = true,
  className,
}: FrontendTypeBadgeProps) {
  // If it's a shared frontend, show shared badge regardless of frontendType
  const effectiveType = isSharedFrontend ? 'shared' : type;

  const getTypeConfig = (frontendType: string) => {
    switch (frontendType) {
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
      case "shared":
        return {
          label: "Shared",
          icon: IconRoute,
          className: "text-purple-700 border-purple-200 bg-purple-50 dark:text-purple-300 dark:border-purple-800 dark:bg-purple-950",
        };
      default:
        return {
          label: frontendType,
          icon: IconRoute,
          className: "text-gray-700 border-gray-200 bg-gray-50 dark:text-gray-300 dark:border-gray-800 dark:bg-gray-950",
        };
    }
  };

  const config = getTypeConfig(effectiveType);
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
