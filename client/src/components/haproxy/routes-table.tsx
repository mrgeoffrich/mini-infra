import { useState } from "react";
import {
  IconPlus,
  IconRefresh,
  IconAlertCircle,
  IconRoute,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useFrontendRoutes } from "@/hooks/use-haproxy-routes";
import { HAProxyRouteInfo } from "@mini-infra/types";
import { RouteRow } from "./route-row";
import { AddRouteDialog } from "./add-route-dialog";

interface RoutesTableProps {
  frontendName: string;
  frontendId: string;
  environmentId: string | null;
}

export function RoutesTable({ frontendName, frontendId, environmentId }: RoutesTableProps) {
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const {
    data: routesResponse,
    isLoading,
    error,
    refetch,
  } = useFrontendRoutes(frontendName, {
    refetchInterval: 30000,
  });

  const routes = routesResponse?.data?.routes || [];

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconRoute className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Routes</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    // Check if it's because this is not a shared frontend
    const isNotSharedFrontend = error.message?.includes("not a shared frontend");

    if (isNotSharedFrontend) {
      return null; // Don't show routes table for non-shared frontends
    }

    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconRoute className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Routes</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {error instanceof Error ? error.message : "Failed to load routes"}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconRoute className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Routes ({routes.length})</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <IconRefresh className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <Button size="sm" onClick={() => setAddDialogOpen(true)}>
                <IconPlus className="h-4 w-4 mr-2" />
                Add Route
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {routes.length === 0 ? (
            <div className="text-center py-8">
              <IconRoute className="mx-auto h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-semibold">No routes configured</h3>
              <p className="mt-2 text-muted-foreground">
                Add a route to start directing traffic to backends.
              </p>
              <Button className="mt-4" onClick={() => setAddDialogOpen(true)}>
                <IconPlus className="h-4 w-4 mr-2" />
                Add Route
              </Button>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hostname</TableHead>
                    <TableHead>Backend</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>SSL</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routes.map((route: HAProxyRouteInfo) => (
                    <RouteRow
                      key={route.id}
                      route={route}
                      frontendName={frontendName}
                      environmentId={environmentId}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddRouteDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        frontendName={frontendName}
        frontendId={frontendId}
        environmentId={environmentId}
      />
    </>
  );
}
