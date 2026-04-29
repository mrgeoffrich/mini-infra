import { useState } from "react";
import { useParams, Link, Navigate, useSearchParams } from "react-router-dom";
import { Environment } from "@mini-infra/types";
import { useEnvironment } from "@/hooks/use-environments";
import { StacksList } from "@/components/environments";
import { useUserStacks } from "@/hooks/use-applications";
import { EnvironmentEditDialog } from "@/components/environments/environment-edit-dialog";
import { EnvironmentDeleteDialog } from "@/components/environments/environment-delete-dialog";
import { RemediateHAProxyDialog } from "@/components/haproxy/remediate-haproxy-dialog";
import { EgressTab } from "@/components/egress/egress-tab";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  IconSettings,
  IconTrash,
  IconDots,
  IconAlertCircle,
  IconApps,
  IconNetwork,
  IconCloud,
  IconWorldWww,
  IconHome,
  IconShield,
} from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { cn } from "@/lib/utils";

export function EnvironmentDetailPage() {
  const { id: environmentId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") === "egress" ? "egress" : "overview";

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [remediateDialogOpen, setRemediateDialogOpen] = useState(false);

  // Note: regular browser sessions always have null permissions (full access).
  // API key auth will need to plumb permissions through here in a future slice.

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

  const { formatDateTime, formatRelativeTime } = useFormattedDate();

  // Fetch user-deployed application stacks
  const { data: userStacksData } = useUserStacks();
  const userStacks = (userStacksData?.data ?? []).filter(
    (s) => s.environmentId === environmentId,
  );

  // Gate the Egress tab behind egress:read.
  // Browser sessions have full access (null permissions = full access).
  // When API key auth surfaces session permissions to the client in a future
  // slice, replace `true` with: hasPermission(session.permissions, "egress:read")
  const canReadEgress = true;

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
        <div className="grid gap-6 md:grid-cols-2 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Applications</CardTitle>
              <IconApps className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {userStacks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No applications deployed</p>
              ) : (
                <div className="space-y-1.5">
                  {userStacks.map((stack) => (
                    <div key={stack.id} className="flex items-center justify-between text-sm">
                      <span className="truncate font-medium">{stack.name}</span>
                      <Badge
                        variant={stack.status === "synced" ? "default" : "secondary"}
                        className="text-xs ml-2 shrink-0"
                      >
                        {stack.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Environment Details</CardTitle>
              <IconNetwork className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Network</span>
                  <div className="flex items-center gap-1.5">
                    {environment.networkType === "internet" ? (
                      <IconWorldWww className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                    ) : (
                      <IconHome className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className="font-medium capitalize">{environment.networkType}</span>
                  </div>
                </div>

                {environment.networkType === "internet" && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Tunnel</span>
                    {environment.tunnelId ? (
                      <div className="flex items-center gap-1.5">
                        <IconCloud className="h-3.5 w-3.5 text-orange-500" />
                        <span className="font-medium font-mono text-xs truncate max-w-[160px]" title={environment.tunnelId}>
                          {environment.tunnelId}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground italic">Not configured</span>
                    )}
                  </div>
                )}

                {environment.networks.length > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Docker Networks</span>
                    <span className="font-medium">{environment.networks.length}</span>
                  </div>
                )}

                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Created</span>
                  <span className="font-medium" title={formatDateTime(environment.createdAt)}>
                    {formatRelativeTime(environment.createdAt)}
                  </span>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Updated</span>
                  <span className="font-medium" title={formatDateTime(environment.updatedAt)}>
                    {formatRelativeTime(environment.updatedAt)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-full">
        <Tabs defaultValue={initialTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {canReadEgress && (
              <TabsTrigger value="egress" className="flex items-center gap-1.5">
                <IconShield className="h-3.5 w-3.5" />
                Egress
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="overview">
            <StacksList environmentId={environment.id} />
          </TabsContent>

          {canReadEgress && (
            <TabsContent value="egress">
              <EgressTab environmentId={environment.id} />
            </TabsContent>
          )}
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