import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Rocket,
  CheckCircle,
  XCircle,
  Clock,
  ArrowRight,
  Plus,
} from "lucide-react";
import { useDeploymentConfigs } from "@/hooks/use-deployment-configs";
import { useActiveDeployments } from "@/hooks/use-deployment-history";
import { DeploymentInfo } from "@mini-infra/types";

const getStatusColor = (status: string) => {
  switch (status) {
    case "completed":
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300";
    case "failed":
    case "rolling_back":
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
    case "deploying":
    case "health_checking":
    case "switching_traffic":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
    case "pending":
    case "preparing":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300";
  }
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case "completed":
      return <CheckCircle className="h-4 w-4" />;
    case "failed":
    case "rolling_back":
      return <XCircle className="h-4 w-4" />;
    case "deploying":
    case "health_checking":
    case "switching_traffic":
    case "pending":
    case "preparing":
      return <Clock className="h-4 w-4" />;
    default:
      return <Clock className="h-4 w-4" />;
  }
};

export function DeploymentSummary() {
  const [showAll, setShowAll] = useState(false);

  // Fetch deployment configurations
  const {
    data: configsResponse,
    isLoading: isLoadingConfigs,
    error: configsError,
  } = useDeploymentConfigs({
    filters: { isActive: true },
    page: 1,
    limit: 10,
    sortBy: "updatedAt",
    sortOrder: "desc",
  });

  // Fetch recent deployments
  const { data: deploymentsResponse, isLoading: isLoadingDeployments } =
    useActiveDeployments({
      page: 1,
      limit: 5,
      sortBy: "startedAt",
      sortOrder: "desc",
    });

  const configs = configsResponse?.data || [];
  const deployments = deploymentsResponse?.data || [];
  const displayedDeployments = showAll ? deployments : deployments.slice(0, 3);

  // Calculate summary stats
  const totalConfigs = configs.length;
  const runningDeployments = deployments.filter((d) =>
    ["deploying", "health_checking", "switching_traffic", "preparing"].includes(
      d.status,
    ),
  ).length;
  const failedDeployments = deployments.filter((d) =>
    ["failed", "rolling_back"].includes(d.status),
  ).length;

  if (configsError) {
    return (
      <div className="px-4 lg:px-6">
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              Failed to Load Deployments
            </CardTitle>
            <CardDescription>
              Unable to load deployment information. Please try refreshing the
              page.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 space-y-6">
      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Deployment Configurations
            </CardTitle>
            <Rocket className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingConfigs ? (
                <Skeleton className="h-8 w-12" />
              ) : (
                totalConfigs
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Active configurations
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Active Deployments
            </CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingDeployments ? (
                <Skeleton className="h-8 w-12" />
              ) : (
                runningDeployments
              )}
            </div>
            <p className="text-xs text-muted-foreground">Currently deploying</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Failed Deployments
            </CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingDeployments ? (
                <Skeleton className="h-8 w-12" />
              ) : (
                failedDeployments
              )}
            </div>
            <p className="text-xs text-muted-foreground">Require attention</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Deployments */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Rocket className="h-5 w-5" />
                Recent Deployments
              </CardTitle>
              <CardDescription>
                Latest deployment activity across all applications
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/deployments">
                  <Plus className="h-4 w-4 mr-2" />
                  New Deployment
                </Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/deployments">
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingDeployments ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="space-y-1">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                  <Skeleton className="h-6 w-20" />
                </div>
              ))}
            </div>
          ) : deployments.length === 0 ? (
            <div className="text-center py-8">
              <Rocket className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold mb-2">No deployments yet</h3>
              <p className="text-muted-foreground mb-4">
                Get started by creating your first deployment configuration.
              </p>
              <Button asChild>
                <Link to="/deployments">
                  <Plus className="h-4 w-4 mr-2" />
                  Create Configuration
                </Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {displayedDeployments.map((deployment: DeploymentInfo) => {
                const config = configs.find(
                  (c) => c.id === deployment.configurationId,
                );
                return (
                  <div
                    key={deployment.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0">
                        <div
                          className={`flex items-center justify-center w-10 h-10 rounded-full ${getStatusColor(deployment.status)}`}
                        >
                          {getStatusIcon(deployment.status)}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-medium truncate">
                          {config?.applicationName || "Unknown App"}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {deployment.dockerImage} •{" "}
                          {new Date(deployment.startedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={getStatusColor(deployment.status)}
                      >
                        {deployment.status.charAt(0).toUpperCase() +
                          deployment.status.slice(1).replace(/_/g, " ")}
                      </Badge>
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/deployments`}>
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                );
              })}

              {deployments.length > 3 && (
                <div className="text-center pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAll(!showAll)}
                  >
                    {showAll
                      ? "Show Less"
                      : `Show ${deployments.length - 3} More`}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
