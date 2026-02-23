import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useState } from "react";
import {
  IconArrowLeft,
  IconServer,
  IconInfoCircle,
  IconSettings,
  IconCalendar,
  IconAlertCircle,
  IconRocket,
  IconEye,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useBackendByName } from "@/hooks/use-haproxy-backends";
import { useEnvironments } from "@/hooks/use-environments";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { ServersTable } from "@/components/haproxy/servers-table";
import { EditBackendDialog } from "@/components/haproxy/edit-backend-dialog";

function BackendStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge
          variant="outline"
          className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950"
        >
          Active
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="outline"
          className="text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950"
        >
          Failed
        </Badge>
      );
    case "removed":
      return (
        <Badge
          variant="outline"
          className="text-gray-700 border-gray-200 bg-gray-50 dark:text-gray-300 dark:border-gray-800 dark:bg-gray-950"
        >
          Removed
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function BackendSourceBadge({ sourceType }: { sourceType: string }) {
  switch (sourceType) {
    case "deployment":
      return (
        <Badge variant="secondary" className="gap-1">
          <IconRocket className="h-3 w-3" />
          Deployment
        </Badge>
      );
    case "manual":
      return (
        <Badge variant="outline" className="gap-1">
          <IconSettings className="h-3 w-3" />
          Manual
        </Badge>
      );
    default:
      return <Badge variant="outline">{sourceType}</Badge>;
  }
}

export function BackendDetailsPage() {
  const { backendName } = useParams<{ backendName: string }>();
  const [searchParams] = useSearchParams();
  const environmentId = searchParams.get("environmentId");
  const navigate = useNavigate();
  const { formatDateTime } = useFormattedDate();
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  // Fetch backend details
  const {
    data: backendResponse,
    isLoading,
    error,
  } = useBackendByName(backendName, environmentId || undefined, {
    refetchInterval: 30000,
  });

  // Fetch environments to get environment name
  const { data: environmentsResponse } = useEnvironments({
    filters: { limit: 100 },
  });

  const backend = backendResponse?.data;
  const environment = environmentsResponse?.environments?.find(
    (env) => env.id === backend?.environmentId,
  );

  const handleBack = () => {
    navigate("/haproxy/backends");
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        </div>
        <div className="px-4 lg:px-6 max-w-7xl">
          <Skeleton className="h-[300px] w-full" />
        </div>
        <div className="px-4 lg:px-6 max-w-7xl">
          <Skeleton className="h-[250px] w-full" />
        </div>
      </div>
    );
  }

  // Error state
  if (error || !backend) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button variant="ghost" onClick={handleBack}>
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back to Backends
          </Button>

          <div className="mt-6 p-4 border border-destructive/50 bg-destructive/10 rounded-md flex items-start gap-3">
            <IconAlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">
                Failed to load backend
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Backend not found"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <Button variant="ghost" onClick={handleBack} className="mb-4">
          <IconArrowLeft className="h-4 w-4 mr-2" />
          Back to Backends
        </Button>

        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconServer className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-3xl font-bold font-mono">
                  {backend.name}
                </h1>
                <BackendSourceBadge sourceType={backend.sourceType} />
                <BackendStatusBadge status={backend.status} />
              </div>
              <p className="text-muted-foreground">
                Backend server group details and configuration
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Overview Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <IconInfoCircle className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Overview</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Name</p>
                <p className="font-medium font-mono">{backend.name}</p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <IconServer className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Environment</p>
                </div>
                {environment ? (
                  <Button
                    variant="link"
                    className="h-auto p-0 font-medium text-base"
                    onClick={() => navigate(`/environments/${environment.id}`)}
                  >
                    {environment.name}
                  </Button>
                ) : (
                  <p className="font-medium">Unknown</p>
                )}
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Source Type</p>
                <div>
                  <BackendSourceBadge sourceType={backend.sourceType} />
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Status</p>
                <div>
                  <BackendStatusBadge status={backend.status} />
                </div>
              </div>

              {backend.deploymentConfigId && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Deployment Config
                  </p>
                  <Button
                    variant="link"
                    className="h-auto p-0 font-medium text-sm font-mono"
                    onClick={() =>
                      navigate(`/deployments/${backend.deploymentConfigId}`)
                    }
                  >
                    <IconEye className="h-3 w-3 mr-1" />
                    {backend.deploymentConfigId}
                  </Button>
                </div>
              )}

              {backend.manualFrontendId && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Manual Frontend
                  </p>
                  <p className="font-medium text-sm font-mono">
                    {backend.manualFrontendId}
                  </p>
                </div>
              )}

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <IconCalendar className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Created</p>
                </div>
                <p className="font-medium">
                  {formatDateTime(backend.createdAt)}
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <IconCalendar className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Updated</p>
                </div>
                <p className="font-medium">
                  {formatDateTime(backend.updatedAt)}
                </p>
              </div>

              {backend.status === "failed" && backend.errorMessage && (
                <div className="col-span-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <IconAlertCircle className="h-4 w-4 text-destructive" />
                    <p className="text-sm text-destructive">Error Message</p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {backend.errorMessage}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Configuration Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <IconSettings className="h-5 w-5 text-muted-foreground" />
                <CardTitle>Configuration</CardTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditDialogOpen(true)}
              >
                Edit Configuration
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Mode</p>
                <p className="font-medium">{backend.mode}</p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Balance Algorithm
                </p>
                <Badge variant="secondary" className="font-mono text-xs">
                  {backend.balanceAlgorithm}
                </Badge>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Check Timeout
                </p>
                <p className="font-medium">
                  {backend.checkTimeout ? `${backend.checkTimeout}ms` : "Default"}
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Connect Timeout
                </p>
                <p className="font-medium">
                  {backend.connectTimeout
                    ? `${backend.connectTimeout}ms`
                    : "Default"}
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Server Timeout
                </p>
                <p className="font-medium">
                  {backend.serverTimeout
                    ? `${backend.serverTimeout}ms`
                    : "Default"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Servers Table */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <ServersTable
          backendName={backend.name}
          environmentId={backend.environmentId}
        />
      </div>

      {/* Edit Backend Dialog */}
      <EditBackendDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        backend={backend}
        environmentId={backend.environmentId}
      />
    </div>
  );
}

export default BackendDetailsPage;
