import { useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { Environment } from "@mini-infra/types";
import { useEnvironment } from "@/hooks/use-environments";
import { NetworkList, VolumeList, StacksList } from "@/components/environments";
import { useStacks } from "@/hooks/use-stacks";
import { EnvironmentEditDialog } from "@/components/environments/environment-edit-dialog";
import { EnvironmentDeleteDialog } from "@/components/environments/environment-delete-dialog";
import { HAProxyStatusCard } from "@/components/environments/haproxy-status-card";
import { RemediateHAProxyDialog } from "@/components/haproxy/remediate-haproxy-dialog";
import {
  Card,
  CardContent,
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
  IconArrowLeft,
  IconServer,
  IconNetwork,
  IconDatabase,
  IconSettings,
  IconTrash,
  IconDots,
  IconAlertCircle,
  IconStack2,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export function EnvironmentDetailPage() {
  const { id: environmentId } = useParams<{ id: string }>();

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [remediateDialogOpen, setRemediateDialogOpen] = useState(false);

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

  // Fetch stacks for overview card
  const { data: stacksData } = useStacks(environmentId);

  if (!environmentId) {
    return <Navigate to="/environments" replace />;
  }

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

  if (isError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" asChild>
              <Link to="/environments">
                <IconArrowLeft className="h-4 w-4 mr-2" />
                Back to Environments
              </Link>
            </Button>
          </div>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
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
                <IconArrowLeft className="h-4 w-4 mr-2" />
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
                <IconArrowLeft className="h-4 w-4 mr-2" />
                Back to Environments
              </Link>
            </Button>
          </div>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Environment not found
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" asChild>
              <Link to="/environments">
                <IconArrowLeft className="h-4 w-4 mr-2" />
                Back to Environments
              </Link>
            </Button>
            <div className="h-6 border-l border-border" />
            <div className="p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <IconServer className="h-6 w-6" />
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
              </div>
              {environment.description && (
                <p className="text-muted-foreground">
                  {environment.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <IconDots className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => setEditDialogOpen(true)}
                  className="flex items-center gap-2"
                >
                  <IconSettings className="h-4 w-4" />
                  Edit Environment
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setDeleteDialogOpen(true)}
                  className="flex items-center gap-2 text-red-600 focus:text-red-600"
                >
                  <IconTrash className="h-4 w-4" />
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
              <CardTitle className="text-sm font-medium">Networks</CardTitle>
              <IconNetwork className="h-4 w-4 text-muted-foreground" />
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
              <IconDatabase className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{environment.volumes.length}</div>
              <p className="text-xs text-muted-foreground">
                Docker volumes
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Stacks</CardTitle>
              <IconStack2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stacksData?.data?.length ?? 0}</div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {stacksData?.data?.filter((s) => s.status === "synced").length ?? 0} synced
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* HAProxy Status Card */}
        <HAProxyStatusCard
          environmentId={environment.id}
          onRemediateClick={() => setRemediateDialogOpen(true)}
          className="mb-6"
        />
      </div>

      <div className="px-4 lg:px-6 max-w-full">
        <Tabs defaultValue="stacks" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="stacks" className="flex items-center gap-2">
              <IconStack2 className="h-4 w-4" />
              Stacks
            </TabsTrigger>
            <TabsTrigger value="networks" className="flex items-center gap-2">
              <IconNetwork className="h-4 w-4" />
              Networks
            </TabsTrigger>
            <TabsTrigger value="volumes" className="flex items-center gap-2">
              <IconDatabase className="h-4 w-4" />
              Volumes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="stacks" forceMount >
            <StacksList environmentId={environment.id} />
          </TabsContent>

          <TabsContent value="networks" forceMount >
            <NetworkList environmentId={environment.id} />
          </TabsContent>

          <TabsContent value="volumes" forceMount >
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

      <RemediateHAProxyDialog
        environmentId={environment.id}
        environmentName={environment.name}
        open={remediateDialogOpen}
        onOpenChange={setRemediateDialogOpen}
        onSuccess={() => refetch()}
      />
    </div>
  );
}