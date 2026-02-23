import { useState } from "react";
import {
  IconDots,
  IconTrash,
  IconEdit,
  IconShield,
  IconRocket,
  IconSettings,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { TableCell, TableRow } from "@/components/ui/table";
import { useDeleteRoute } from "@/hooks/use-haproxy-routes";
import { HAProxyRouteInfo } from "@mini-infra/types";
import { EditRouteDialog } from "./edit-route-dialog";
import { toast } from "sonner";

interface RouteRowProps {
  route: HAProxyRouteInfo;
  frontendName: string;
  environmentId: string | null;
}

function RouteStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge variant="outline" className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950">
          Active
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="text-yellow-700 border-yellow-200 bg-yellow-50 dark:text-yellow-300 dark:border-yellow-800 dark:bg-yellow-950">
          Pending
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950">
          Failed
        </Badge>
      );
    default:
      return (
        <Badge variant="outline">
          {status}
        </Badge>
      );
  }
}

function RouteSourceBadge({ sourceType }: { sourceType: string }) {
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
      return (
        <Badge variant="outline">
          {sourceType}
        </Badge>
      );
  }
}

export function RouteRow({ route, frontendName, environmentId }: RouteRowProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const deleteRouteMutation = useDeleteRoute();
  const { formatDateTime } = useFormattedDate();
  const navigate = useNavigate();

  const handleDelete = async () => {
    try {
      await deleteRouteMutation.mutateAsync({
        frontendName,
        routeId: route.id,
      });
      toast.success("Route deleted successfully");
      setDeleteDialogOpen(false);
    } catch (error) {
      toast.error(
        `Failed to delete route: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  // Determine if this route can be deleted
  // Deployment routes should be managed through the deployment config
  const canDelete = route.sourceType === "manual";

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="font-medium">{route.hostname}</div>
          <div className="text-xs text-muted-foreground">{route.aclName}</div>
        </TableCell>
        <TableCell>
          <button
            className="font-mono text-sm text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
            onClick={() => {
              const params = environmentId ? `?environmentId=${environmentId}` : "";
              navigate(`/haproxy/backends/${route.backendName}${params}`);
            }}
          >
            {route.backendName}
          </button>
        </TableCell>
        <TableCell>
          <RouteSourceBadge sourceType={route.sourceType} />
          {route.sourceType === "deployment" && route.deploymentConfigId && (
            <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate max-w-[140px]" title={route.deploymentConfigId}>
              {route.deploymentConfigId}
            </div>
          )}
          {route.sourceType === "manual" && route.manualFrontendId && (
            <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate max-w-[140px]" title={route.manualFrontendId}>
              {route.manualFrontendId}
            </div>
          )}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1">
            {route.useSSL ? (
              <IconShield className="h-4 w-4 text-green-600" />
            ) : (
              <span className="text-muted-foreground text-xs">No</span>
            )}
          </div>
          {route.useSSL && route.tlsCertificateId && (
            <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate max-w-[140px]" title={route.tlsCertificateId}>
              {route.tlsCertificateId}
            </div>
          )}
        </TableCell>
        <TableCell>
          <span className="text-sm">{route.priority}</span>
        </TableCell>
        <TableCell>
          <RouteStatusBadge status={route.status} />
        </TableCell>
        <TableCell>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {formatDateTime(route.createdAt)}
          </span>
        </TableCell>
        <TableCell>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {formatDateTime(route.updatedAt)}
          </span>
        </TableCell>
        <TableCell>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <IconDots className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canDelete && (
                <DropdownMenuItem onClick={() => setEditDialogOpen(true)}>
                  <IconEdit className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>
              )}
              {canDelete ? (
                <DropdownMenuItem
                  onClick={() => setDeleteDialogOpen(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <IconTrash className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled>
                  <IconRocket className="h-4 w-4 mr-2" />
                  Managed by Deployment
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      {/* Edit Route Dialog */}
      {canDelete && (
        <EditRouteDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          route={route}
          frontendName={frontendName}
          environmentId={environmentId}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Route</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the route for "{route.hostname}"?
              This will remove the ACL and backend switching rule from HAProxy.
              <br />
              <br />
              Traffic to this hostname will no longer be routed to the backend.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteRouteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteRouteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteRouteMutation.isPending ? (
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
    </>
  );
}
