import { useState } from "react";
import { EnvironmentNetwork } from "@mini-infra/types";
import {
  useEnvironmentNetworks,
} from "@/hooks/use-environments";
import { NetworkCreateDialog } from "./network-create-dialog";
import { NetworkEditDialog } from "./network-edit-dialog";
import { NetworkDeleteDialog } from "./network-delete-dialog";
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
import { Plus, RefreshCw, Network, MoreHorizontal, Edit, Trash2, AlertCircle } from "lucide-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";

interface NetworkListProps {
  environmentId: string;
  className?: string;
}

export function NetworkList({ environmentId, className }: NetworkListProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedNetwork, setSelectedNetwork] = useState<EnvironmentNetwork | null>(null);

  const { formatDateTime } = useFormattedDate();

  const {
    data: networksData,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useEnvironmentNetworks(environmentId, {
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const networks = networksData?.networks || [];

  const handleEdit = (network: EnvironmentNetwork) => {
    setSelectedNetwork(network);
    setEditDialogOpen(true);
  };

  const handleDelete = (network: EnvironmentNetwork) => {
    setSelectedNetwork(network);
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
    setSelectedNetwork(null);
    refetch();
  };

  const handleDeleteSuccess = () => {
    setDeleteDialogOpen(false);
    setSelectedNetwork(null);
    refetch();
  };

  if (isError) {
    return (
      <div className={className}>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load networks: {error instanceof Error ? error.message : "Unknown error"}
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
              <div className="p-2 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
                <Network className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Networks</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Manage Docker networks for this environment
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
                <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Network
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
          ) : networks.length === 0 ? (
            <div className="text-center py-8">
              <Network className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Networks Found</h3>
              <p className="text-muted-foreground mb-4">
                This environment doesn't have any networks yet.
              </p>
              <Button onClick={() => setCreateDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Network
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
                {networks.map((network) => (
                  <TableRow key={network.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Network className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{network.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{network.driver}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(network.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(network)}>
                            <Edit className="h-4 w-4 mr-2" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(network)}
                            className="text-red-600"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
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
      <NetworkCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        environmentId={environmentId}
        onSuccess={handleCreateSuccess}
      />

      {selectedNetwork && (
        <>
          <NetworkEditDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            environmentId={environmentId}
            network={selectedNetwork}
            onSuccess={handleEditSuccess}
          />

          <NetworkDeleteDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            environmentId={environmentId}
            network={selectedNetwork}
            onSuccess={handleDeleteSuccess}
          />
        </>
      )}
    </div>
  );
}