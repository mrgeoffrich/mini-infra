import { Link } from "react-router-dom";
import { Environment, EnvironmentNetworkType } from "@mini-infra/types";
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
  IconStack2,
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
        {/* Counts */}
        <div className="text-sm space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <IconStack2 className="h-4 w-4" />
            <span>{environment.stackCount} {environment.stackCount === 1 ? 'Application' : 'Applications'}</span>
          </div>
          {environment.systemStackCount > 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <IconStack2 className="h-4 w-4" />
              <span>{environment.systemStackCount} Infrastructure {environment.systemStackCount === 1 ? 'Stack' : 'Stacks'}</span>
            </div>
          )}
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