import { useState } from "react";
import { EnvironmentVolume } from "@mini-infra/types";
import {
  useEnvironmentVolumes,
} from "@/hooks/use-environments";
import { VolumeCreateDialog } from "./volume-create-dialog";
import { VolumeEditDialog } from "./volume-edit-dialog";
import { VolumeDeleteDialog } from "./volume-delete-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconPlus, IconRefresh, IconDatabase, IconDots, IconEdit, IconTrash, IconAlertCircle } from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";

interface VolumeListProps {
  environmentId: string;
  className?: string;
}

export function VolumeList({ environmentId, className }: VolumeListProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedVolume, setSelectedVolume] = useState<EnvironmentVolume | null>(null);

  const { formatDateTime } = useFormattedDate();

  const {
    data: volumesData,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useEnvironmentVolumes(environmentId, {
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const volumes = volumesData?.volumes || [];

  const handleEdit = (volume: EnvironmentVolume) => {
    setSelectedVolume(volume);
    setEditDialogOpen(true);
  };

  const handleDelete = (volume: EnvironmentVolume) => {
    setSelectedVolume(volume);
    setDeleteDialogOpen(true);
  };

  const handleRefresh = () => {
    refetch();
  };

  const handleCreateSuccess = () => {
    setCreateDialogOpen(false);
    refetch();
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    setSelectedVolume(null);
    refetch();
  };

  const handleDeleteSuccess = () => {
    setDeleteDialogOpen(false);
    setSelectedVolume(null);
    refetch();
  };

  if (isError) {
    return (
      <div className={className}>
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load volumes: {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
                <IconDatabase className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Volumes</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Manage Docker volumes for this environment
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefetching}
              >
                <IconRefresh className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => setCreateDialogOpen(true)}
              >
                <IconPlus className="h-4 w-4 mr-2" />
                Create Volume
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ))}
            </div>
          ) : volumes.length === 0 ? (
            <div className="text-center py-8">
              <IconDatabase className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Volumes Found</h3>
              <p className="text-muted-foreground mb-4">
                This environment doesn't have any volumes yet.
              </p>
              <Button onClick={() => setCreateDialogOpen(true)}>
                <IconPlus className="h-4 w-4 mr-2" />
                Create Volume
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {volumes.map((volume) => (
                  <TableRow key={volume.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <IconDatabase className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{volume.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{volume.driver}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(volume.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <IconDots className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(volume)}>
                            <IconEdit className="h-4 w-4 mr-2" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(volume)}
                            className="text-red-600"
                          >
                            <IconTrash className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <VolumeCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        environmentId={environmentId}
        onSuccess={handleCreateSuccess}
      />

      {selectedVolume && (
        <>
          <VolumeEditDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            environmentId={environmentId}
            volume={selectedVolume}
            onSuccess={handleEditSuccess}
          />

          <VolumeDeleteDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            environmentId={environmentId}
            volume={selectedVolume}
            onSuccess={handleDeleteSuccess}
          />
        </>
      )}
    </div>
  );
}