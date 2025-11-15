import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  IconPlus,
  IconRefresh,
  IconDatabase,
  IconShield,
  IconDots,
  IconEye,
  IconTrash,
  IconUser,
  IconUserEdit,
  IconPlugConnected,
} from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  useManagedDatabases,
  useCreateManagedDatabase,
  useDeleteManagedDatabase,
  useChangeDatabaseOwner,
  useSyncDatabases,
} from "@/hooks/use-managed-databases";
import { useGrantsForDatabase } from "@/hooks/use-database-grants";
import { DatabaseModal } from "./database-modal";
import { ChangeOwnerModal } from "./change-owner-modal";
import { GrantEditor } from "./grant-editor";
import { ConnectionStringModal } from "./connection-string-modal";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CreateManagedDatabaseRequest, ChangeDatabaseOwnerRequest, ManagedDatabaseUserInfo, ManagedDatabaseInfo } from "@mini-infra/types";

interface DatabasesTabProps {
  serverId: string;
  availableUsers: ManagedDatabaseUserInfo[];
  serverHost: string;
  serverPort: number;
}

export function DatabasesTab({ serverId, availableUsers, serverHost, serverPort }: DatabasesTabProps) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [databaseToDelete, setDatabaseToDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [userSelectionDialogOpen, setUserSelectionDialogOpen] = useState(false);
  const [selectedDatabaseForGrants, setSelectedDatabaseForGrants] =
    useState<ManagedDatabaseInfo | null>(null);
  const [grantEditorOpen, setGrantEditorOpen] = useState(false);
  const [selectedUserForGrant, setSelectedUserForGrant] =
    useState<ManagedDatabaseUserInfo | null>(null);
  const [changeOwnerDialogOpen, setChangeOwnerDialogOpen] = useState(false);
  const [databaseToChangeOwner, setDatabaseToChangeOwner] =
    useState<ManagedDatabaseInfo | null>(null);
  const [connectionStringDialogOpen, setConnectionStringDialogOpen] = useState(false);
  const [databaseForConnection, setDatabaseForConnection] =
    useState<ManagedDatabaseInfo | null>(null);

  const { formatRelativeTime } = useFormattedDate();

  // Fetch grants for the selected database (only when needed)
  const { data: grantsResponse } = useGrantsForDatabase(
    selectedDatabaseForGrants ? serverId : undefined,
    selectedDatabaseForGrants?.id,
  );

  // Fetch databases
  const {
    data: databasesResponse,
    isLoading,
    error,
  } = useManagedDatabases(serverId);
  const databases = databasesResponse?.data || [];

  // Mutations
  const createMutation = useCreateManagedDatabase(serverId);
  const deleteMutation = useDeleteManagedDatabase(serverId);
  const changeOwnerMutation = useChangeDatabaseOwner(serverId);
  const syncMutation = useSyncDatabases(serverId);

  const handleCreateDatabase = async (data: CreateManagedDatabaseRequest) => {
    try {
      await createMutation.mutateAsync(data);
      toast.success("Database created successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to create database");
      throw error;
    }
  };

  const handleDeleteDatabase = (databaseId: string, databaseName: string) => {
    setDatabaseToDelete({ id: databaseId, name: databaseName });
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!databaseToDelete) return;

    try {
      await deleteMutation.mutateAsync(databaseToDelete.id);
      toast.success(`Database "${databaseToDelete.name}" deleted successfully`);
      setDeleteDialogOpen(false);
      setDatabaseToDelete(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to delete database");
    }
  };

  const handleChangeOwner = (database: ManagedDatabaseInfo) => {
    setDatabaseToChangeOwner(database);
    setChangeOwnerDialogOpen(true);
  };

  const handleChangeOwnerSubmit = async (data: ChangeDatabaseOwnerRequest) => {
    if (!databaseToChangeOwner) return;

    try {
      await changeOwnerMutation.mutateAsync({
        databaseId: databaseToChangeOwner.id,
        ownerData: data,
      });
      toast.success(
        `Database owner changed to "${data.newOwner}" successfully`
      );
      setChangeOwnerDialogOpen(false);
      setDatabaseToChangeOwner(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to change database owner");
      throw error;
    }
  };

  const handleSyncDatabases = async () => {
    try {
      const result = await syncMutation.mutateAsync();
      toast.success(
        result.message ||
          `Synced successfully: ${result.data.created} created, ${result.data.updated} updated`,
      );
    } catch (error: any) {
      toast.error(error.message || "Failed to sync databases");
    }
  };

  const handleManageGrants = (database: ManagedDatabaseInfo) => {
    setSelectedDatabaseForGrants(database);
    setUserSelectionDialogOpen(true);
  };

  const handleUserSelected = (user: ManagedDatabaseUserInfo) => {
    setSelectedUserForGrant(user);
    setUserSelectionDialogOpen(false);
    setGrantEditorOpen(true);
  };

  const handleGrantEditorClose = () => {
    setGrantEditorOpen(false);
    // Clear selections after a short delay to avoid visual glitch
    setTimeout(() => {
      setSelectedDatabaseForGrants(null);
      setSelectedUserForGrant(null);
    }, 200);
  };

  const handleConnect = (database: ManagedDatabaseInfo) => {
    setDatabaseForConnection(database);
    setConnectionStringDialogOpen(true);
  };

  // Find existing grant for the selected database and user
  const existingGrant =
    grantsResponse?.data.find(
      (grant) => grant.userId === selectedUserForGrant?.id,
    ) || undefined;

  const formatBytes = (bytes: number | null): string => {
    if (bytes === null) return "Unknown";
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <Skeleton className="h-6 w-32 mb-2" />
                <Skeleton className="h-4 w-64" />
              </div>
              <Skeleton className="h-10 w-32" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-destructive py-6">
              <p className="text-sm">Failed to load databases</p>
              <p className="text-xs mt-1">{error.message}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Empty state
  if (databases.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Databases</CardTitle>
                <CardDescription>
                  Manage databases on this server
                </CardDescription>
              </div>
              <Button onClick={() => setIsCreateModalOpen(true)}>
                <IconPlus className="h-4 w-4 mr-2" />
                Create Database
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="p-4 rounded-full bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300 mb-4">
                <IconDatabase className="h-12 w-12" />
              </div>
              <h3 className="text-lg font-semibold mb-2">No databases found</h3>
              <p className="text-muted-foreground mb-4 max-w-sm">
                Create your first database or sync from the server to see
                existing databases
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={handleSyncDatabases}
                  disabled={syncMutation.isPending}
                >
                  <IconRefresh
                    className={cn(
                      "h-4 w-4 mr-2",
                      syncMutation.isPending && "animate-spin",
                    )}
                  />
                  Sync from Server
                </Button>
                <Button onClick={() => setIsCreateModalOpen(true)}>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Create Database
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <DatabaseModal
          open={isCreateModalOpen}
          onOpenChange={setIsCreateModalOpen}
          serverId={serverId}
          availableUsers={availableUsers}
          onSubmit={handleCreateDatabase}
        />
      </div>
    );
  }

  // Database list view
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Databases</CardTitle>
              <CardDescription>
                Manage databases on this server
              </CardDescription>
            </div>
            <Button onClick={() => setIsCreateModalOpen(true)}>
              <IconPlus className="h-4 w-4 mr-2" />
              Create Database
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Sync indicator */}
          <div className="flex items-center justify-between mb-4 pb-4 border-b">
            <div className="text-sm text-muted-foreground">
              {databases.length} database{databases.length !== 1 ? "s" : ""}
              {databases[0]?.lastSyncedAt && (
                <span className="ml-2">
                  • Last synced {formatRelativeTime(databases[0].lastSyncedAt)}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncDatabases}
              disabled={syncMutation.isPending}
            >
              <IconRefresh
                className={cn(
                  "h-4 w-4 mr-2",
                  syncMutation.isPending && "animate-spin",
                )}
              />
              Sync
            </Button>
          </div>

          {/* Database List */}
          <div className="space-y-2">
            {databases.map((db) => (
              <div
                key={db.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start gap-3 flex-1">
                  <IconDatabase className="h-5 w-5 text-purple-600 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-sm">
                        {db.databaseName}
                      </h4>
                      {db._count && db._count.grants > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {db._count.grants} grant
                          {db._count.grants !== 1 ? "s" : ""}
                        </Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2 text-xs text-muted-foreground">
                      <div>
                        <span className="font-medium">Owner:</span> {db.owner}
                      </div>
                      <div>
                        <span className="font-medium">Encoding:</span>{" "}
                        {db.encoding}
                      </div>
                      {db.sizeBytes !== null && (
                        <div>
                          <span className="font-medium">Size:</span>{" "}
                          {formatBytes(db.sizeBytes)}
                        </div>
                      )}
                      {db.connectionLimit !== -1 && (
                        <div>
                          <span className="font-medium">Connections:</span>{" "}
                          {db.connectionLimit}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleManageGrants(db)}
                  >
                    <IconShield className="h-4 w-4 mr-1" />
                    Grants
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <IconDots className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleConnect(db)}>
                        <IconPlugConnected className="h-4 w-4 mr-2" />
                        Connect
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        <IconEye className="h-4 w-4 mr-2" />
                        View Details
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleChangeOwner(db)}>
                        <IconUserEdit className="h-4 w-4 mr-2" />
                        Change Owner
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() =>
                          handleDeleteDatabase(db.id, db.databaseName)
                        }
                        className="text-destructive"
                      >
                        <IconTrash className="h-4 w-4 mr-2" />
                        Drop Database
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Modals */}
      <DatabaseModal
        open={isCreateModalOpen}
        onOpenChange={setIsCreateModalOpen}
        serverId={serverId}
        availableUsers={availableUsers}
        onSubmit={handleCreateDatabase}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop Database</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to drop the database "
              {databaseToDelete?.name}"? This action cannot be undone and will
              permanently delete all data in the database.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Dropping..." : "Drop Database"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* User Selection Dialog */}
      <Dialog
        open={userSelectionDialogOpen}
        onOpenChange={setUserSelectionDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select User</DialogTitle>
            <DialogDescription>
              Choose a user to manage permissions for{" "}
              <span className="font-mono">
                {selectedDatabaseForGrants?.databaseName}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {availableUsers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">No users available</p>
                <p className="text-xs mt-1">
                  Create users first to manage permissions
                </p>
              </div>
            ) : (
              availableUsers.map((user) => {
                const isOwner =
                  user.username === selectedDatabaseForGrants?.owner;
                return (
                  <button
                    key={user.id}
                    onClick={() => handleUserSelected(user)}
                    className="w-full flex items-center gap-3 p-3 border rounded-lg hover:bg-accent transition-colors text-left"
                  >
                    <IconUser className="h-5 w-5 text-blue-600" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm font-mono">
                          {user.username}
                        </span>
                        {isOwner && (
                          <Badge variant="outline" className="text-xs border-purple-500 text-purple-700 dark:text-purple-300">
                            Database Owner
                          </Badge>
                        )}
                        {user.isSuperuser && (
                          <Badge variant="destructive" className="text-xs">
                            Superuser
                          </Badge>
                        )}
                      </div>
                      {user._count && user._count.grants > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {user._count.grants} grant
                          {user._count.grants !== 1 ? "s" : ""}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Grant Editor */}
      {selectedDatabaseForGrants && selectedUserForGrant && (
        <GrantEditor
          open={grantEditorOpen}
          onOpenChange={handleGrantEditorClose}
          serverId={serverId}
          database={selectedDatabaseForGrants}
          user={selectedUserForGrant}
          existingGrant={existingGrant}
        />
      )}

      {/* Change Owner Modal */}
      {databaseToChangeOwner && (
        <ChangeOwnerModal
          open={changeOwnerDialogOpen}
          onOpenChange={setChangeOwnerDialogOpen}
          database={databaseToChangeOwner}
          availableUsers={availableUsers}
          onSubmit={handleChangeOwnerSubmit}
        />
      )}

      {/* Connection String Modal */}
      {databaseForConnection && (
        <ConnectionStringModal
          open={connectionStringDialogOpen}
          onOpenChange={setConnectionStringDialogOpen}
          database={databaseForConnection}
          serverHost={serverHost}
          serverPort={serverPort}
        />
      )}
    </div>
  );
}
