import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useContainers } from "@/hooks/useContainers";
import { AlertCircle, ArrowRight, Container, Play, Square, Pause } from "lucide-react";

export function ContainerSummary() {
  const {
    data: containerData,
    isLoading,
    error,
    isError,
    refetch,
  } = useContainers({
    queryParams: {},
    enabled: true,
    refetchInterval: 30000, // Poll every 30 seconds
  });

  const handleRetry = () => {
    refetch();
  };

  if (isError) {
    return (
      <div className="px-4 lg:px-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load container data. {error?.message}
            <button
              onClick={handleRetry}
              className="ml-2 underline hover:no-underline"
            >
              Try again
            </button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading && !containerData) {
    return (
      <div className="px-4 lg:px-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <div className="mt-6">
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  const containers = containerData?.containers || [];
  const totalContainers = containers.length;
  const runningContainers = containers.filter(c => c.status === "running").length;
  const stoppedContainers = containers.filter(c => c.status === "exited").length;
  const pausedContainers = containers.filter(c => c.status === "paused").length;
  const otherContainers = totalContainers - runningContainers - stoppedContainers - pausedContainers;

  // Check for recently died containers (exited in the last 24 hours)
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  const recentlyDiedContainers = containers.filter(container => {
    if (container.status !== "exited") return false;
    
    // Check if the container started recently (as a proxy for when it might have stopped)
    const startedAt = container.startedAt ? new Date(container.startedAt) : null;
    return startedAt && startedAt > twentyFourHoursAgo;
  });

  return (
    <div className="px-4 lg:px-6 space-y-6">
      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Containers</CardTitle>
            <Container className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalContainers}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Running</CardTitle>
            <Play className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{runningContainers}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Stopped</CardTitle>
            <Square className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stoppedContainers}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Paused</CardTitle>
            <Pause className="h-4 w-4 text-yellow-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{pausedContainers}</div>
            {otherContainers > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                +{otherContainers} other
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recently Died Containers Alert */}
      {recentlyDiedContainers.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="flex items-center justify-between">
              <span>
                {recentlyDiedContainers.length} container{recentlyDiedContainers.length === 1 ? '' : 's'} 
                {recentlyDiedContainers.length === 1 ? ' has' : ' have'} stopped in the last 24 hours
              </span>
              <Button asChild variant="outline" size="sm">
                <Link to="/containers?status=exited">
                  View Details
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <div className="mt-2 space-y-1">
              {recentlyDiedContainers.slice(0, 3).map((container) => (
                <div key={container.id} className="text-sm">
                  <span className="font-medium">{container.name}</span>
                  {container.startedAt && (
                    <span className="text-muted-foreground ml-2">
                      started {new Date(container.startedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              ))}
              {recentlyDiedContainers.length > 3 && (
                <div className="text-sm text-muted-foreground">
                  and {recentlyDiedContainers.length - 3} more...
                </div>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}