import { useState, useMemo } from "react";
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
  IconUser,
  IconShield,
  IconDots,
  IconEdit,
  IconKey,
  IconTrash,
  IconFilter,
  IconDatabase,
} from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  useManagedDatabaseUsers,
  useCreateManagedDatabaseUser,
  useUpdateManagedDatabaseUser,
  useChangeUserPassword,
  useDeleteManagedDatabaseUser,
  useSyncUsers,
} from "@/hooks/use-managed-database-users";
import { useGrantsForUser } from "@/hooks/use-database-grants";
import { UserModal } from "./user-modal";
import { ChangePasswordModal } from "./change-password-modal";
import { GrantEditor } from "./grant-editor";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  CreateManagedDatabaseUserRequest,
  UpdateManagedDatabaseUserRequest,
  ManagedDatabaseUserInfo,
  ManagedDatabaseInfo,
} from "@mini-infra/types";

interface UsersTabProps {
  serverId: string;
  availableDatabases: ManagedDatabaseInfo[];
}

export function UsersTab({ serverId, availableDatabases }: UsersTabProps) {
  const [showSystemUsers, setShowSystemUsers] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedDatabaseUserInfo | null>(
    null,
  );
  const [changingPasswordUser, setChangingPasswordUser] =
    useState<ManagedDatabaseUserInfo | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<{
    id: string;
    username: string;
    isSuperuser: boolean;
  } | null>(null);
  const [databaseSelectionDialogOpen, setDatabaseSelectionDialogOpen] =
    useState(false);
  const [selectedUserForGrants, setSelectedUserForGrants] =
    useState<ManagedDatabaseUserInfo | null>(null);
  const [grantEditorOpen, setGrantEditorOpen] = useState(false);
  const [selectedDatabaseForGrant, setSelectedDatabaseForGrant] =
    useState<ManagedDatabaseInfo | null>(null);

  const { formatRelativeTime } = useFormattedDate();

  // Fetch grants for the selected user (only when needed)
  const { data: grantsResponse } = useGrantsForUser(
    selectedUserForGrants ? serverId : undefined,
    selectedUserForGrants?.id,
  );

  // Fetch users
  const { data: usersResponse, isLoading, error } = useManagedDatabaseUsers(serverId);
  const users = useMemo(() => usersResponse?.data || [], [usersResponse]);

  // Filter users based on showSystemUsers toggle
  const filteredUsers = useMemo(() => {
    if (showSystemUsers) {
      return users;
    }
    // Filter out common system users
    const systemUserPatterns = [
      /^postgres$/,
      /^pg_/,
      /^rds_/,
      /^azure_/,
      /^cloudsql/,
    ];
    return users.filter(
      (user) =>
        !systemUserPatterns.some((pattern) => pattern.test(user.username)),
    );
  }, [users, showSystemUsers]);

  // Mutations
  const createMutation = useCreateManagedDatabaseUser(serverId);
  const updateMutation = useUpdateManagedDatabaseUser(serverId);
  const changePasswordMutation = useChangeUserPassword(serverId);
  const deleteMutation = useDeleteManagedDatabaseUser(serverId);
  const syncMutation = useSyncUsers(serverId);

  const handleCreateUser = async (data: CreateManagedDatabaseUserRequest) => {
    try {
      await createMutation.mutateAsync(data);
      toast.success("User created successfully");
      setIsCreateModalOpen(false);
    } catch (error) {
      toast.error((error instanceof Error ? error.message : String(error)) || "Failed to create user");
      throw error;
    }
  };

  const handleUpdateUser = async (
    userId: string,
    updates: UpdateManagedDatabaseUserRequest,
  ) => {
    try {
      await updateMutation.mutateAsync({ userId, updates });
      toast.success("User updated successfully");
      setEditingUser(null);
    } catch (error) {
      toast.error((error instanceof Error ? error.message : String(error)) || "Failed to update user");
      throw error;
    }
  };

  const handleChangePassword = async (userId: string, password: string) => {
    try {
      await changePasswordMutation.mutateAsync({ userId, password });
      toast.success("Password changed successfully");
      setChangingPasswordUser(null);
    } catch (error) {
      toast.error((error instanceof Error ? error.message : String(error)) || "Failed to change password");
      throw error;
    }
  };

  const handleDeleteUser = (
    userId: string,
    username: string,
    isSuperuser: boolean,
  ) => {
    setUserToDelete({ id: userId, username, isSuperuser });
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!userToDelete) return;

    try {
      await deleteMutation.mutateAsync(userToDelete.id);
      toast.success(`User "${userToDelete.username}" deleted successfully`);
      setDeleteDialogOpen(false);
      setUserToDelete(null);
    } catch (error) {
      toast.error((error instanceof Error ? error.message : String(error)) || "Failed to delete user");
    }
  };

  const handleSyncUsers = async () => {
    try {
      const result = await syncMutation.mutateAsync();
      toast.success(
        result.message ||
          `Synced successfully: ${result.data.created} created, ${result.data.updated} updated`,
      );
    } catch (error) {
      toast.error((error instanceof Error ? error.message : String(error)) || "Failed to sync users");
    }
  };

  const handleManageGrants = (user: ManagedDatabaseUserInfo) => {
    setSelectedUserForGrants(user);
    setDatabaseSelectionDialogOpen(true);
  };

  const handleDatabaseSelected = (database: ManagedDatabaseInfo) => {
    setSelectedDatabaseForGrant(database);
    setDatabaseSelectionDialogOpen(false);
    setGrantEditorOpen(true);
  };

  const handleGrantEditorClose = () => {
    setGrantEditorOpen(false);
    // Clear selections after a short delay to avoid visual glitch
    setTimeout(() => {
      setSelectedUserForGrants(null);
      setSelectedDatabaseForGrant(null);
    }, 200);
  };

  // Find existing grant for the selected user and database
  const existingGrant =
    grantsResponse?.data.find(
      (grant) => grant.databaseId === selectedDatabaseForGrant?.id,
    ) || undefined;

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
              <div className="flex gap-2">
                <Skeleton className="h-10 w-32" />
                <Skeleton className="h-10 w-32" />
              </div>
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
              <p className="text-sm">Failed to load users</p>
              <p className="text-xs mt-1">{(error instanceof Error ? error.message : String(error))}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Empty state
  if (filteredUsers.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Users</CardTitle>
                <CardDescription>
                  Manage database users on this server
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowSystemUsers(!showSystemUsers)}
                >
                  <IconFilter className="h-4 w-4 mr-2" />
                  {showSystemUsers ? "Hide System Users" : "Show System Users"}
                </Button>
                <Button onClick={() => setIsCreateModalOpen(true)}>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Create User
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="p-4 rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300 mb-4">
                <IconUser className="h-12 w-12" />
              </div>
              <h3 className="text-lg font-semibold mb-2">
                {showSystemUsers ? "No users found" : "No application users"}
              </h3>
              <p className="text-muted-foreground mb-4 max-w-sm">
                {showSystemUsers
                  ? "Create your first user or sync from the server"
                  : "Create application users or show system users to see all"}
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={handleSyncUsers}
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
                  Create User
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <UserModal
          open={isCreateModalOpen}
          onOpenChange={setIsCreateModalOpen}
          serverId={serverId}
          mode="create"
          onSubmit={handleCreateUser}
        />
      </div>
    );
  }

  // User list view
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Users</CardTitle>
              <CardDescription>
                Manage database users on this server
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowSystemUsers(!showSystemUsers)}
              >
                <IconFilter className="h-4 w-4 mr-2" />
                {showSystemUsers ? "Hide System Users" : "Show System Users"}
              </Button>
              <Button onClick={() => setIsCreateModalOpen(true)}>
                <IconPlus className="h-4 w-4 mr-2" />
                Create User
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Sync indicator */}
          <div className="flex items-center justify-between mb-4 pb-4 border-b">
            <div className="text-sm text-muted-foreground">
              {filteredUsers.length} user{filteredUsers.length !== 1 ? "s" : ""}
              {!showSystemUsers && users.length > filteredUsers.length && (
                <span className="ml-2">
                  ({users.length - filteredUsers.length} system users hidden)
                </span>
              )}
              {users[0]?.lastSyncedAt && (
                <span className="ml-2">
                  • Last synced {formatRelativeTime(users[0].lastSyncedAt)}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncUsers}
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

          {/* User List */}
          <div className="space-y-2">
            {filteredUsers.map((user) => (
              <div
                key={user.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start gap-3 flex-1">
                  <IconUser className="h-5 w-5 text-blue-600 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold text-sm font-mono">
                        {user.username}
                      </h4>

                      {user.isSuperuser && (
                        <Badge variant="destructive" className="text-xs">
                          Superuser
                        </Badge>
                      )}

                      {!user.canLogin && (
                        <Badge variant="secondary" className="text-xs">
                          No Login
                        </Badge>
                      )}

                      {user._count && user._count.grants > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {user._count.grants} grant
                          {user._count.grants !== 1 ? "s" : ""}
                        </Badge>
                      )}
                    </div>

                    <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                      {user.connectionLimit !== -1 && (
                        <div>
                          <span className="font-medium">Connection Limit:</span>{" "}
                          {user.connectionLimit}
                        </div>
                      )}
                      {user.passwordSetAt && (
                        <div>
                          <span className="font-medium">Password Set:</span>{" "}
                          {formatRelativeTime(user.passwordSetAt)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleManageGrants(user)}
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
                      <DropdownMenuItem onClick={() => setEditingUser(user)}>
                        <IconEdit className="h-4 w-4 mr-2" />
                        Edit User
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setChangingPasswordUser(user)}
                      >
                        <IconKey className="h-4 w-4 mr-2" />
                        Change Password
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() =>
                          handleDeleteUser(
                            user.id,
                            user.username,
                            user.isSuperuser,
                          )
                        }
                        className="text-destructive"
                        disabled={user.isSuperuser}
                      >
                        <IconTrash className="h-4 w-4 mr-2" />
                        Drop User
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
      <UserModal
        open={isCreateModalOpen}
        onOpenChange={setIsCreateModalOpen}
        serverId={serverId}
        mode="create"
        onSubmit={handleCreateUser}
      />

      {editingUser && (
        <UserModal
          open={!!editingUser}
          onOpenChange={(open) => !open && setEditingUser(null)}
          serverId={serverId}
          mode="edit"
          userId={editingUser.id}
          onSubmit={(data) => handleUpdateUser(editingUser.id, data)}
        />
      )}

      {changingPasswordUser && (
        <ChangePasswordModal
          open={!!changingPasswordUser}
          onOpenChange={(open) => !open && setChangingPasswordUser(null)}
          username={changingPasswordUser.username}
          onSubmit={(password) =>
            handleChangePassword(changingPasswordUser.id, password)
          }
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to drop the user "{userToDelete?.username}
              "? This action cannot be undone and will revoke all permissions
              for this user.
              {userToDelete?.isSuperuser && (
                <span className="block mt-2 text-destructive font-semibold">
                  Warning: This is a superuser account. Dropping it may cause
                  system issues.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteMutation.isPending || userToDelete?.isSuperuser}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Dropping..." : "Drop User"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Database Selection Dialog */}
      <Dialog
        open={databaseSelectionDialogOpen}
        onOpenChange={setDatabaseSelectionDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select Database</DialogTitle>
            <DialogDescription>
              Choose a database to manage permissions for{" "}
              <span className="font-mono">
                {selectedUserForGrants?.username}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {availableDatabases.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">No databases available</p>
                <p className="text-xs mt-1">
                  Create databases first to manage permissions
                </p>
              </div>
            ) : (
              availableDatabases.map((database) => (
                <button
                  key={database.id}
                  onClick={() => handleDatabaseSelected(database)}
                  className="w-full flex items-center gap-3 p-3 border rounded-lg hover:bg-accent transition-colors text-left"
                >
                  <IconDatabase className="h-5 w-5 text-purple-600" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm font-mono">
                        {database.databaseName}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>Owner: {database.owner}</span>
                      {database._count && database._count.grants > 0 && (
                        <span>
                          {database._count.grants} grant
                          {database._count.grants !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Grant Editor */}
      {selectedUserForGrants && selectedDatabaseForGrant && (
        <GrantEditor
          open={grantEditorOpen}
          onOpenChange={handleGrantEditorClose}
          serverId={serverId}
          database={selectedDatabaseForGrant}
          user={selectedUserForGrants}
          existingGrant={existingGrant}
        />
      )}
    </div>
  );
}
