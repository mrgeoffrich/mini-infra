import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useSystemSettings,
  useConnectivityStatus,
  useSettingsAudit,
} from "@/hooks/use-settings";
import {
  AlertCircle,
  ArrowRight,
  Settings,
  CheckCircle,
  XCircle,
  Clock,
  Container,
  Cloud,
  Database,
  RefreshCw,
} from "lucide-react";
import { ConnectivityStatusType, SettingsCategory } from "@mini-infra/types";

// Map settings categories to display info
const CATEGORY_INFO = {
  docker: {
    name: "Docker",
    description: "Container management configuration",
    icon: Container,
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
    path: "/settings/docker",
  },
  cloudflare: {
    name: "Cloudflare",
    description: "API keys and tunnel configuration",
    icon: Cloud,
    color:
      "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
    path: "/settings/cloudflare",
  },
  azure: {
    name: "Azure Storage",
    description: "Backup and storage configuration",
    icon: Database,
    color: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300",
    path: "/settings/azure",
  },
} as const;

// Map connectivity status to badge variants
const STATUS_VARIANTS = {
  connected: {
    variant: "default" as const,
    icon: CheckCircle,
    color: "text-green-600",
  },
  failed: {
    variant: "destructive" as const,
    icon: XCircle,
    color: "text-red-600",
  },
  timeout: {
    variant: "secondary" as const,
    icon: Clock,
    color: "text-yellow-600",
  },
  unreachable: {
    variant: "outline" as const,
    icon: AlertCircle,
    color: "text-gray-600",
  },
} as const;

export function SettingsOverview() {
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings,
  } = useSystemSettings({
    filters: { isActive: true },
    limit: 100,
  });

  const {
    data: connectivityData,
    isLoading: connectivityLoading,
    error: connectivityError,
    refetch: refetchConnectivity,
  } = useConnectivityStatus({
    limit: 10,
    refetchInterval: 30000, // Poll every 30 seconds
  });

  const {
    data: auditData,
    isLoading: auditLoading,
  } = useSettingsAudit({
    limit: 5,
  });

  const handleRefresh = () => {
    refetchSettings();
    refetchConnectivity();
  };

  const isLoading = settingsLoading || connectivityLoading;
  const hasError = settingsError || connectivityError;

  if (hasError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <h1 className="text-3xl font-bold mb-2">Settings</h1>
          <p className="text-muted-foreground mb-6">
            System configuration and connectivity overview
          </p>
        </div>
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load settings data.{" "}
              {settingsError?.message || connectivityError?.message}
              <button
                onClick={handleRefresh}
                className="ml-2 underline hover:no-underline"
              >
                Try again
              </button>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  if (isLoading && !settingsData && !connectivityData) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <h1 className="text-3xl font-bold mb-2">Settings</h1>
          <p className="text-muted-foreground mb-6">
            System configuration and connectivity overview
          </p>
        </div>
        <div className="px-4 lg:px-6 space-y-6">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      </div>
    );
  }

  const settings = settingsData?.data || [];
  const connectivityStatuses = connectivityData?.data || [];
  const recentAudits = auditData?.data || [];

  // Group settings by category
  const settingsByCategory = settings.reduce(
    (acc, setting) => {
      if (!acc[setting.category as SettingsCategory]) {
        acc[setting.category as SettingsCategory] = [];
      }
      acc[setting.category as SettingsCategory].push(setting);
      return acc;
    },
    {} as Record<SettingsCategory, typeof settings>,
  );

  // Get latest connectivity status for each service
  const latestConnectivity = connectivityStatuses.reduce(
    (acc, status) => {
      const service = status.service as SettingsCategory;
      if (
        !acc[service] ||
        new Date(status.checkedAt) > new Date(acc[service].checkedAt)
      ) {
        acc[service] = status;
      }
      return acc;
    },
    {} as Record<SettingsCategory, (typeof connectivityStatuses)[0]>,
  );

  const totalSettings = settings.length;
  const activeSettings = settings.filter((s) => s.isActive).length;
  const validSettings = settings.filter(
    (s) => s.validationStatus === "valid",
  ).length;
  const errorSettings = settings.filter(
    (s) => s.validationStatus === "error" || s.validationStatus === "invalid",
  ).length;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Settings</h1>
            <p className="text-muted-foreground mb-6">
              System configuration and connectivity overview
            </p>
          </div>
          <Button onClick={handleRefresh} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Settings
              </CardTitle>
              <Settings className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalSettings}</div>
              <p className="text-xs text-muted-foreground">
                {activeSettings} active
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Valid</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {validSettings}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Errors</CardTitle>
              <XCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">
                {errorSettings}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Categories</CardTitle>
              <Settings className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {Object.keys(settingsByCategory).length}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Service Configuration Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(CATEGORY_INFO) as SettingsCategory[]).map(
            (category) => {
              const info = CATEGORY_INFO[category];
              const categorySettings = settingsByCategory[category] || [];
              const connectivity = latestConnectivity[category];
              const Icon = info.icon;
              const StatusIcon = connectivity
                ? STATUS_VARIANTS[connectivity.status as ConnectivityStatusType]
                    ?.icon || AlertCircle
                : AlertCircle;
              const statusColor = connectivity
                ? STATUS_VARIANTS[connectivity.status as ConnectivityStatusType]
                    ?.color || "text-gray-600"
                : "text-gray-600";

              return (
                <Card key={category} className="relative">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-md ${info.color}`}>
                          <Icon className="h-5 w-5" />
                        </div>
                        <div>
                          <div className="font-semibold">{info.name}</div>
                          <div className="text-sm text-muted-foreground font-normal">
                            {info.description}
                          </div>
                        </div>
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Settings count */}
                    <div className="flex items-center justify-between text-sm">
                      <span>Settings configured</span>
                      <Badge variant="secondary">
                        {categorySettings.length} setting
                        {categorySettings.length !== 1 ? "s" : ""}
                      </Badge>
                    </div>

                    {/* Connectivity Status */}
                    <div className="flex items-center justify-between text-sm">
                      <span>Connectivity</span>
                      {connectivity ? (
                        <div className="flex items-center gap-1">
                          <StatusIcon className={`h-4 w-4 ${statusColor}`} />
                          <Badge
                            variant={
                              STATUS_VARIANTS[
                                connectivity.status as ConnectivityStatusType
                              ]?.variant || "outline"
                            }
                          >
                            {connectivity.status}
                          </Badge>
                        </div>
                      ) : (
                        <Badge variant="outline">Unknown</Badge>
                      )}
                    </div>

                    {/* Last checked */}
                    {connectivity && (
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Last checked</span>
                        <span>
                          {new Date(connectivity.checkedAt).toLocaleString()}
                        </span>
                      </div>
                    )}

                    {/* Response time */}
                    {connectivity?.responseTimeMs && (
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Response time</span>
                        <span>{connectivity.responseTimeMs}ms</span>
                      </div>
                    )}

                    {/* Configure button */}
                    <Button asChild variant="outline" className="w-full">
                      <Link to={info.path}>
                        Configure {info.name}
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              );
            },
          )}
        </div>

        {/* Recent Configuration Changes */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Recent Changes</CardTitle>
            </CardHeader>
            <CardContent>
              {auditLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                </div>
              ) : recentAudits.length > 0 ? (
                <div className="space-y-3">
                  {recentAudits.slice(0, 5).map((audit) => (
                    <div
                      key={audit.id}
                      className="flex items-start gap-3 p-3 rounded-md border"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className="text-xs">
                            {audit.action}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {audit.category}
                          </Badge>
                        </div>
                        <div className="text-sm font-medium truncate">
                          {audit.key}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(audit.createdAt).toLocaleString()}
                        </div>
                      </div>
                      {audit.success ? (
                        <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0 mt-1" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-1" />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No recent changes
                </p>
              )}

              <div className="mt-4">
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link to="/settings/audit">
                    View All Changes
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Service Health Summary */}
          <Card>
            <CardHeader>
              <CardTitle>Service Health</CardTitle>
            </CardHeader>
            <CardContent>
              {connectivityLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                </div>
              ) : connectivityStatuses.length > 0 ? (
                <div className="space-y-3">
                  {(Object.keys(CATEGORY_INFO) as SettingsCategory[]).map(
                    (category) => {
                      const info = CATEGORY_INFO[category];
                      const connectivity = latestConnectivity[category];
                      const Icon = info.icon;
                      const StatusIcon = connectivity
                        ? STATUS_VARIANTS[
                            connectivity.status as ConnectivityStatusType
                          ]?.icon || AlertCircle
                        : AlertCircle;
                      const statusColor = connectivity
                        ? STATUS_VARIANTS[
                            connectivity.status as ConnectivityStatusType
                          ]?.color || "text-gray-600"
                        : "text-gray-600";

                      return (
                        <div
                          key={category}
                          className="flex items-center justify-between p-3 rounded-md border"
                        >
                          <div className="flex items-center gap-3">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{info.name}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {connectivity?.responseTimeMs && (
                              <span className="text-xs text-muted-foreground">
                                {connectivity.responseTimeMs}ms
                              </span>
                            )}
                            <StatusIcon className={`h-4 w-4 ${statusColor}`} />
                            <Badge
                              variant={
                                connectivity
                                  ? STATUS_VARIANTS[
                                      connectivity.status as ConnectivityStatusType
                                    ]?.variant || "outline"
                                  : "outline"
                              }
                              className="text-xs"
                            >
                              {connectivity?.status || "unknown"}
                            </Badge>
                          </div>
                        </div>
                      );
                    },
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No connectivity data available
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
