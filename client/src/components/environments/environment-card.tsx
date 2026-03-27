import { Link } from "react-router-dom";
import { Environment, EnvironmentType, EnvironmentNetworkType } from "@mini-infra/types";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  IconNetwork,
  IconDatabase,
} from "@tabler/icons-react";

interface EnvironmentCardProps {
  environment: Environment;
  onEdit?: (environment: Environment) => void;
  onDelete?: (environment: Environment) => void;
  className?: string;
}

export function EnvironmentCard({
  environment,
  className,
}: EnvironmentCardProps) {
  const { formatDateTime } = useFormattedDate();

  const getTypeColor = (type: EnvironmentType) => {
    return type === "production"
      ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      : "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
  };

  const getNetworkTypeColor = (networkType: EnvironmentNetworkType) => {
    return networkType === "internet"
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
      : "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300";
  };

  return (
    <Link to={`/environments/${environment.id}`} className="block">
      <Card
        className={cn(
          "transition-all hover:shadow-md cursor-pointer",
          className
        )}
      >
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg font-semibold">
              {environment.name}
            </CardTitle>
            <Badge
              variant="outline"
              className={cn("text-xs", getTypeColor(environment.type))}
            >
              {environment.type}
            </Badge>
            <Badge
              variant="outline"
              className={cn("text-xs", getNetworkTypeColor(environment.networkType))}
            >
              {environment.networkType}
            </Badge>
          </div>
          {environment.description && (
            <CardDescription className="text-sm">
              {environment.description}
            </CardDescription>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Networks and Volumes */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <IconNetwork className="h-4 w-4" />
            <span>{environment.networks.length} Networks</span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <IconDatabase className="h-4 w-4" />
            <span>{environment.volumes.length} Volumes</span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground">
          <span>Created {formatDateTime(environment.createdAt)}</span>
        </div>
      </CardContent>
      </Card>
    </Link>
  );
}