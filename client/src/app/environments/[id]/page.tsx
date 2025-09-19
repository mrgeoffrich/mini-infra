import { useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { Environment } from "@mini-infra/types";
import { useEnvironment, useStartEnvironment, useStopEnvironment } from "@/hooks/use-environments";
import { NetworkList, VolumeList } from "@/components/environments";
import { EnvironmentEditDialog } from "@/components/environments/environment-edit-dialog";
import { EnvironmentDeleteDialog } from "@/components/environments/environment-delete-dialog";
import { ServiceAddDialog } from "@/components/environments/service-add-dialog";
import { EnvironmentStatus, ServiceHealth } from "@/components/environments/environment-status";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Server,
  Network,
  HardDrive,
  Play,
  Square,
  Settings,
  Trash2,
  MoreHorizontal,
  Users,
  AlertCircle,
} from "lucide-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ApplicationServiceHealthStatusValues = {
  HEALTHY: 'healthy' as const,
  UNHEALTHY: 'unhealthy' as const,
  UNKNOWN: 'unknown' as const,
};

export function EnvironmentDetailPage() {
  const { id: environmentId } = useParams<{ id: string }>();
  const { formatDateTime } = useFormattedDate();

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [serviceAddDialogOpen, setServiceAddDialogOpen] = useState(false);
  const [isOperating, setIsOperating] = useState(false);

  const startMutation = useStartEnvironment();
  const stopMutation = useStopEnvironment();

  const {
    data: environment,
    isLoading,
    isError,
    error,
    refetch,
  } = useEnvironment(environmentId || "", {
    refetchInterval: 10000, // Refetch every 10 seconds for real-time updates
    enabled: !!environmentId, // Only fetch if environmentId exists
  });

  if (!environmentId) {
    return <Navigate to="/environments" replace />;
  }

  const isRunning = environment?.status === "running";
  const canStart = environment?.status === "stopped" || environment?.status === "failed";
  const canStop = environment?.status === "running" || environment?.status === "degraded";

  const handleStart = async () => {
    if (!environment) return;
    setIsOperating(true);
    try {
      await startMutation.mutateAsync(environment.id);
      toast.success(`Environment "${environment.name}" started successfully`);
    } catch (error) {
      toast.error(
        `Failed to start environment: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsOperating(false);
    }
  };

  const handleStop = async () => {
    if (!environment) return;
    setIsOperating(true);
    try {
      await stopMutation.mutateAsync(environment.id);
      toast.success(`Environment "${environment.name}" stopped successfully`);
    } catch (error) {
      toast.error(
        `Failed to stop environment: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsOperating(false);
    }
  };

  const getTypeColor = (type: Environment['type']) => {
    return type === "production"
      ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      : "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    refetch();
  };

  const handleDeleteSuccess = () => {
    setDeleteDialogOpen(false);
    // Navigate back to environments list after successful deletion
    window.location.href = "/environments";
  };

  const handleServiceAddSuccess = () => {
    setServiceAddDialogOpen(false);
    refetch();
  };

  if (isError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" asChild>
              <Link to="/environments">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Environments
              </Link>
            </Button>
          </div>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load environment: {error instanceof Error ? error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" asChild>
              <Link to="/environments">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Environments
              </Link>
            </Button>
          </div>
          <div className="space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
            <div className="grid gap-6 md:grid-cols-3">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!environment) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" asChild>
              <Link to="/environments">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Environments
              </Link>
            </Button>
          </div>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Environment not found
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const healthyServices = environment.services.filter(
    (service) => service.health === ApplicationServiceHealthStatusValues.HEALTHY,
  ).length;
  const totalServices = environment.services.length;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" asChild>
              <Link to="/environments">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Environments
              </Link>
            </Button>
            <div className="h-6 border-l border-border" />
            <div className="p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <Server className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-bold">{environment.name}</h1>
                <Badge
                  variant="outline"
                  className={cn("text-xs", getTypeColor(environment.type))}
                >
                  {environment.type}
                </Badge>
                <EnvironmentStatus status={environment.status} />
              </div>
              {environment.description && (
                <p className="text-muted-foreground">
                  {environment.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canStart && (
              <Button
                onClick={handleStart}
                disabled={isOperating}
                className="flex items-center gap-2"
              >
                <Play className="h-4 w-4" />
                Start Environment
              </Button>
            )}
            {canStop && (
              <Button
                variant="outline"
                onClick={handleStop}
                disabled={isOperating}
                className="flex items-center gap-2"
              >
                <Square className="h-4 w-4" />
                Stop Environment
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => setServiceAddDialogOpen(true)}
                  className="flex items-center gap-2"
                >
                  <Server className="h-4 w-4" />
                  Add Service
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setEditDialogOpen(true)}
                  className="flex items-center gap-2"
                >
                  <Settings className="h-4 w-4" />
                  Edit Environment
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setDeleteDialogOpen(true)}
                  className="flex items-center gap-2 text-red-600 focus:text-red-600"
                  disabled={isRunning}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete Environment
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Environment Overview */}
        <div className="grid gap-6 md:grid-cols-3 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Services</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalServices}</div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{healthyServices} healthy</span>
                {totalServices > 0 && (
                  <div className="flex items-center gap-1">
                    {healthyServices === totalServices ? (
                      <ServiceHealth health={ApplicationServiceHealthStatusValues.HEALTHY} />
                    ) : healthyServices > 0 ? (
                      <ServiceHealth health={ApplicationServiceHealthStatusValues.UNKNOWN} />
                    ) : (
                      <ServiceHealth health={ApplicationServiceHealthStatusValues.UNHEALTHY} />
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Networks</CardTitle>
              <Network className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{environment.networks.length}</div>
              <p className="text-xs text-muted-foreground">
                Docker networks
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Volumes</CardTitle>
              <HardDrive className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{environment.volumes.length}</div>
              <p className="text-xs text-muted-foreground">
                Docker volumes
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-full">
        <Tabs defaultValue="services" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="services" className="flex items-center gap-2">
              <Server className="h-4 w-4" />
              Services
            </TabsTrigger>
            <TabsTrigger value="networks" className="flex items-center gap-2">
              <Network className="h-4 w-4" />
              Networks
            </TabsTrigger>
            <TabsTrigger value="volumes" className="flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              Volumes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="services" className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
                      <Server className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle>Services</CardTitle>
                      <CardDescription>
                        Services running in this environment
                      </CardDescription>
                    </div>
                  </div>
                  <Button
                    onClick={() => setServiceAddDialogOpen(true)}
                  >
                    <Server className="h-4 w-4 mr-2" />
                    Add Service
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {environment.services.length === 0 ? (
                  <div className="text-center py-8">
                    <Server className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No Services Found</h3>
                    <p className="text-muted-foreground mb-4">
                      This environment doesn't have any services yet.
                    </p>
                    <Button onClick={() => setServiceAddDialogOpen(true)}>
                      <Server className="h-4 w-4 mr-2" />
                      Add Service
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-4">
                    {environment.services.map((service) => (
                      <div
                        key={service.id}
                        className="flex items-center justify-between rounded-md border p-4"
                      >
                        <div className="flex items-center gap-3">
                          <Server className="h-5 w-5 text-muted-foreground" />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{service.serviceName}</span>
                              <Badge variant="outline" className="text-xs">
                                {service.serviceType}
                              </Badge>
                            </div>
                            {service.lastError && (
                              <p className="text-sm text-red-600 mt-1">
                                {service.lastError.message}
                              </p>
                            )}
                            <div className="text-sm text-muted-foreground mt-1">
                              Created {formatDateTime(service.createdAt)}
                              {service.startedAt && (
                                <span> • Started {formatDateTime(service.startedAt)}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <EnvironmentStatus status={service.status} />
                          <ServiceHealth health={service.health} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="networks">
            <NetworkList environmentId={environment.id} />
          </TabsContent>

          <TabsContent value="volumes">
            <VolumeList environmentId={environment.id} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialogs */}
      <EnvironmentEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        environment={environment}
        onSuccess={handleEditSuccess}
      />

      <EnvironmentDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        environment={environment}
        onSuccess={handleDeleteSuccess}
      />

      <ServiceAddDialog
        open={serviceAddDialogOpen}
        onOpenChange={setServiceAddDialogOpen}
        environment={environment}
        onSuccess={handleServiceAddSuccess}
      />
    </div>
  );
}