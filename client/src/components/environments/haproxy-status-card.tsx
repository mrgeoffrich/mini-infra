import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useHAProxyStatus } from "@/hooks/use-haproxy-remediation";
import {
  IconRouter,
  IconRoute,
  IconAlertTriangle,
  IconCheck,
  IconRefresh,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

interface HAProxyStatusCardProps {
  environmentId: string;
  onRemediateClick: () => void;
  className?: string;
}

export function HAProxyStatusCard({
  environmentId,
  onRemediateClick,
  className,
}: HAProxyStatusCardProps) {
  const {
    data: statusResponse,
    isLoading,
    isError,
    error,
    refetch,
  } = useHAProxyStatus(environmentId, {
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">HAProxy Status</CardTitle>
          <IconRouter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className={className}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">HAProxy Status</CardTitle>
          <IconRouter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <Alert variant="destructive" className="py-2">
            <AlertDescription className="text-sm">
              {error instanceof Error ? error.message : "Failed to load status"}
            </AlertDescription>
          </Alert>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => refetch()}
          >
            <IconRefresh className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const status = statusResponse?.data;

  // No HAProxy service configured
  if (!status?.hasHAProxy) {
    return (
      <Card className={className}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">HAProxy Status</CardTitle>
          <IconRouter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No HAProxy service configured for this environment.
          </p>
        </CardContent>
      </Card>
    );
  }

  const isHealthy = !status.needsRemediation && status.sharedFrontendsCount && status.sharedFrontendsCount > 0;
  const hasLegacyConfig = status.legacyFrontendsCount && status.legacyFrontendsCount > 0;

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium">HAProxy Status</CardTitle>
          <CardDescription className="text-xs">
            Load balancer configuration
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {status.needsRemediation ? (
            <Badge variant="outline" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">
              <IconAlertTriangle className="h-3 w-3 mr-1" />
              Needs Remediation
            </Badge>
          ) : isHealthy ? (
            <Badge variant="outline" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <IconCheck className="h-3 w-3 mr-1" />
              Healthy
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconRouter className="h-4 w-4" />
              <span>Frontends</span>
            </div>
            <div className="text-2xl font-bold">
              {(status.sharedFrontendsCount || 0) + (status.legacyFrontendsCount || 0)}
            </div>
            <div className="text-xs text-muted-foreground">
              {status.sharedFrontendsCount || 0} shared, {status.legacyFrontendsCount || 0} legacy
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconRoute className="h-4 w-4" />
              <span>Routes</span>
            </div>
            <div className="text-2xl font-bold">{status.totalRoutesCount || 0}</div>
            <div className="text-xs text-muted-foreground">
              {status.deploymentConfigsWithHostnames || 0} deployments with hostnames
            </div>
          </div>
        </div>

        {/* Legacy warning */}
        {hasLegacyConfig && (
          <Alert className="py-2 bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800">
            <IconAlertTriangle className="h-4 w-4 text-yellow-600" />
            <AlertDescription className="text-sm text-yellow-800 dark:text-yellow-200">
              Legacy frontend configuration detected. Consider running remediation to migrate to shared frontends.
            </AlertDescription>
          </Alert>
        )}

        {/* Frontend list preview */}
        {status.frontends && status.frontends.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Frontends</div>
            <div className="space-y-1.5 max-h-32 overflow-y-auto">
              {status.frontends.slice(0, 5).map((frontend) => (
                <div
                  key={frontend.id}
                  className={cn(
                    "flex items-center justify-between rounded-md border p-2 text-sm",
                    frontend.isSharedFrontend
                      ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800"
                      : "bg-gray-50 dark:bg-gray-900"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <IconRouter className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono text-xs">{frontend.frontendName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      :{frontend.bindPort}
                    </Badge>
                    {frontend.isSharedFrontend && (
                      <Badge variant="outline" className="text-xs bg-green-100 dark:bg-green-900">
                        {frontend.routesCount} routes
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
              {status.frontends.length > 5 && (
                <div className="text-xs text-muted-foreground text-center py-1">
                  +{status.frontends.length - 5} more frontends
                </div>
              )}
            </div>
          </div>
        )}

        {/* Remediate button */}
        {status.needsRemediation && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onRemediateClick}
          >
            <IconRefresh className="h-4 w-4 mr-2" />
            Remediate HAProxy
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
