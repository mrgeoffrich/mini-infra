import { useParams, useNavigate } from "react-router-dom";
import { useState } from "react";
import {
  IconArrowLeft,
  IconNetwork,
  IconEdit,
  IconRefresh,
  IconTrash,
  IconInfoCircle,
  IconWorld,
  IconServer,
  IconCalendar,
  IconAlertCircle,
  IconShield,
  IconBan,
  IconBrandDocker,
  IconRocket,
  IconCopy,
  IconEye,
  IconActivity,
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFrontendByName } from "@/hooks/use-haproxy-frontend";
import { useDeleteManualFrontend } from "@/hooks/use-manual-haproxy-frontend";
import { useSyncDeploymentFrontend } from "@/hooks/use-haproxy-frontend";
import { useEnvironments } from "@/hooks/use-environments";
import { FrontendTypeBadge } from "@/components/haproxy/frontend-type-badge";
import { FrontendStatusBadge } from "@/components/deployments/dns-status-badge";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { toast } from "sonner";

export function FrontendDetailsPage() {
  const { frontendName } = useParams<{ frontendName: string }>();
  const navigate = useNavigate();
  const { formatDateTime } = useFormattedDate();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Fetch frontend details
  const {
    data: frontendResponse,
    isLoading,
    error,
    refetch,
  } = useFrontendByName(frontendName, {
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  // Fetch environments to get environment name
  const { data: environmentsResponse } = useEnvironments({
    filters: { limit: 100 },
  });

  const { mutate: deleteFrontend, isPending: isDeleting } =
    useDeleteManualFrontend();
  const syncFrontendMutation = useSyncDeploymentFrontend();

  const frontend = frontendResponse?.data;
  const environment = environmentsResponse?.environments?.find(
    (env) => env.id === frontend?.environmentId
  );

  const handleBack = () => {
    navigate("/haproxy/frontends");
  };

  const handleEdit = () => {
    if (frontend) {
      navigate(`/haproxy/frontends/${frontend.frontendName}/edit`);
    }
  };

  const handleSync = async () => {
    if (frontend?.deploymentConfigId) {
      try {
        await syncFrontendMutation.mutateAsync(frontend.deploymentConfigId);
        toast.success("Frontend synced successfully");
        refetch();
      } catch (error) {
        toast.error(
          `Failed to sync frontend: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }
  };

  const handleDeleteClick = () => {
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (frontend) {
      deleteFrontend(frontend.frontendName, {
        onSuccess: () => {
          setDeleteDialogOpen(false);
          navigate("/haproxy/frontends");
        },
      });
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
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
  if (error || !frontend) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button variant="ghost" onClick={handleBack}>
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back to Frontends
          </Button>

          <div className="mt-6 p-4 border border-destructive/50 bg-destructive/10 rounded-md flex items-start gap-3">
            <IconAlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">
                Failed to load frontend
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Frontend not found"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isManual = frontend.frontendType === "manual";

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <Button variant="ghost" onClick={handleBack} className="mb-4">
          <IconArrowLeft className="h-4 w-4 mr-2" />
          Back to Frontends
        </Button>

        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconNetwork className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-3xl font-bold">{frontend.frontendName}</h1>
                <FrontendTypeBadge type={frontend.frontendType} />
                <FrontendStatusBadge status={frontend.status} />
              </div>
              <p className="text-muted-foreground">
                Frontend connection details and configuration
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isManual && (
              <>
                <Button variant="outline" onClick={handleEdit}>
                  <IconEdit className="h-4 w-4 mr-2" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDeleteClick}
                  className="text-destructive hover:text-destructive"
                >
                  <IconTrash className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </>
            )}
            {!isManual && (
              <Button
                variant="outline"
                onClick={handleSync}
                disabled={syncFrontendMutation.isPending}
              >
                <IconRefresh
                  className={`h-4 w-4 mr-2 ${syncFrontendMutation.isPending ? "animate-spin" : ""}`}
                />
                Sync
              </Button>
            )}
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
                <p className="text-sm text-muted-foreground">Type</p>
                <div>
                  <FrontendTypeBadge type={frontend.frontendType} />
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Status</p>
                <div>
                  <FrontendStatusBadge status={frontend.status} />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <IconWorld className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Hostname</p>
                </div>
                <p className="font-medium">{frontend.hostname}</p>
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
                <div className="flex items-center gap-2">
                  <IconCalendar className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Created</p>
                </div>
                <p className="font-medium">{formatDateTime(frontend.createdAt)}</p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <IconCalendar className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Updated</p>
                </div>
                <p className="font-medium">{formatDateTime(frontend.updatedAt)}</p>
              </div>

              {frontend.status === "failed" && frontend.errorMessage && (
                <div className="col-span-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <IconAlertCircle className="h-4 w-4 text-destructive" />
                    <p className="text-sm text-destructive">Error Message</p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {frontend.errorMessage}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Routing Configuration Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <IconNetwork className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Routing Configuration</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Frontend Name</p>
                <p className="font-medium">{frontend.frontendName}</p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Backend Name</p>
                <p className="font-medium">{frontend.backendName}</p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Bind Address</p>
                <p className="font-medium">
                  {frontend.bindAddress}:{frontend.bindPort}
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {frontend.useSSL ? (
                    <IconShield className="h-4 w-4 text-green-600" />
                  ) : (
                    <IconBan className="h-4 w-4 text-muted-foreground" />
                  )}
                  <p className="text-sm text-muted-foreground">SSL Enabled</p>
                </div>
                <p className="font-medium">
                  {frontend.useSSL ? "Yes" : "No"}
                </p>
              </div>

              {frontend.useSSL && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">SSL Bind Port</p>
                  <p className="font-medium">{frontend.sslBindPort}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Container Details Card (Manual Frontends) */}
      {isManual && (
        <div className="px-4 lg:px-6 max-w-7xl">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <IconBrandDocker className="h-5 w-5 text-muted-foreground" />
                <CardTitle>Container Details</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Container Name</p>
                  <p className="font-medium">
                    {frontend.containerName || "Unknown"}
                  </p>
                </div>

                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Container ID</p>
                  <div className="flex items-center gap-2">
                    <p className="font-medium font-mono text-sm">
                      {frontend.containerId
                        ? frontend.containerId.substring(0, 12)
                        : "Unknown"}
                    </p>
                    {frontend.containerId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCopy(frontend.containerId!)}
                      >
                        <IconCopy className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Container Port</p>
                  <p className="font-medium">{frontend.containerPort || "N/A"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Deployment Details Card (Deployment Frontends) */}
      {!isManual && frontend.deploymentConfigId && (
        <div className="px-4 lg:px-6 max-w-7xl">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <IconRocket className="h-5 w-5 text-muted-foreground" />
                <CardTitle>Deployment Configuration</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Deployment Config ID
                  </p>
                  <p className="font-medium font-mono text-sm">
                    {frontend.deploymentConfigId}
                  </p>
                </div>

                <div>
                  <Button
                    variant="outline"
                    onClick={() =>
                      navigate(`/deployments/${frontend.deploymentConfigId}`)
                    }
                  >
                    <IconEye className="h-4 w-4 mr-2" />
                    View Deployment
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Health Status Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <IconActivity className="h-5 w-5 text-muted-foreground" />
                <CardTitle>Status</CardTitle>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <IconRefresh className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {frontend.status === "active" ? (
                    <IconCircleCheck className="h-5 w-5 text-green-600" />
                  ) : frontend.status === "failed" ? (
                    <IconCircleX className="h-5 w-5 text-red-600" />
                  ) : (
                    <IconActivity className="h-5 w-5 text-yellow-600" />
                  )}
                  <span className="font-medium">Frontend Status</span>
                </div>
                <FrontendStatusBadge status={frontend.status} />
              </div>

              {frontend.useSSL && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <IconShield className="h-5 w-5 text-green-600" />
                    <span className="font-medium">SSL/TLS</span>
                  </div>
                  <Badge variant="outline" className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950">
                    Enabled
                  </Badge>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-2">
              <IconAlertTriangle className="h-5 w-5 text-destructive" />
              <AlertDialogTitle>Delete Manual Frontend</AlertDialogTitle>
            </div>
            <AlertDialogDescription>
              Are you sure you want to delete the frontend "
              {frontend?.frontendName}"? This will remove the frontend
              configuration from HAProxy and stop routing traffic to the
              container.
              <br />
              <br />
              <strong>Note:</strong> The container itself will not be stopped or
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDeleteCancel} disabled={isDeleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <IconTrash className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <IconTrash className="h-4 w-4 mr-2" />
                  Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default FrontendDetailsPage;
