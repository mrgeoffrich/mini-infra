import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  IconAlertCircle,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconKey,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import { useAuth } from "@/hooks/use-auth";
import type { UserInfo } from "@mini-infra/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function UserManagementPage() {
  const queryClient = useQueryClient();
  const { authState } = useAuth();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{
    isOpen: boolean;
    user: UserInfo | null;
  }>({ isOpen: false, user: null });
  const [resetDialog, setResetDialog] = useState<{
    isOpen: boolean;
    user: UserInfo | null;
    tempPassword: string | null;
  }>({ isOpen: false, user: null, tempPassword: null });
  const [copied, setCopied] = useState(false);

  // Form state for add user
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const {
    data: usersData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const response = await fetch("/api/users", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch users");
      const data = await response.json();
      return data.data as UserInfo[];
    },
  });

  const createUserMutation = useMutation({
    mutationFn: async (body: {
      email: string;
      displayName: string;
      password: string;
    }) => {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to create user");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setAddDialogOpen(false);
      setNewEmail("");
      setNewDisplayName("");
      setNewPassword("");
      toastWithCopy.success("User created successfully");
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      const response = await fetch(`/api/users/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to delete user");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setDeleteDialog({ isOpen: false, user: null });
      toastWithCopy.success("User deleted");
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (userId: string) => {
      const response = await fetch(`/api/users/${userId}/reset-password`, {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Failed to reset password");
      return data.data.temporaryPassword as string;
    },
    onSuccess: (tempPassword) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setResetDialog((prev) => ({ ...prev, tempPassword: tempPassword }));
    },
  });

  const handleCopyPassword = async (password: string) => {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>User Management</CardTitle>
            <CardDescription>
              Manage user accounts for Mini Infra
            </CardDescription>
          </div>
          <Button onClick={() => setAddDialogOpen(true)}>
            <IconPlus className="mr-2 h-4 w-4" />
            Add User
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>Failed to load users</AlertDescription>
            </Alert>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Display Name</TableHead>
                  <TableHead>Auth Method</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersData?.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.email}</TableCell>
                    <TableCell>{user.name || "-"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{user.authMethod}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(user.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setResetDialog({
                              isOpen: true,
                              user,
                              tempPassword: null,
                            })
                          }
                        >
                          <IconKey className="mr-1 h-3 w-3" />
                          Reset Password
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() =>
                            setDeleteDialog({ isOpen: true, user })
                          }
                          disabled={user.id === authState.user?.id}
                          title={
                            user.id === authState.user?.id
                              ? "Cannot delete yourself"
                              : undefined
                          }
                        >
                          <IconTrash className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add User Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>
              Create a new user account. They will be prompted to change their
              password on first login.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createUserMutation.mutate({
                email: newEmail,
                displayName: newDisplayName,
                password: newPassword,
              });
            }}
            className="space-y-4"
          >
            {createUserMutation.error && (
              <Alert variant="destructive">
                <IconAlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {createUserMutation.error.message}
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="add-email">Email</Label>
              <Input
                id="add-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-name">Display Name</Label>
              <Input
                id="add-name"
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-password">Temporary Password</Label>
              <Input
                id="add-password"
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 8 chars, 1 letter, 1 number"
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createUserMutation.isPending}
              >
                {createUserMutation.isPending ? (
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Create User
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog.isOpen}
        onOpenChange={(open) =>
          setDeleteDialog({ isOpen: open, user: open ? deleteDialog.user : null })
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong>{deleteDialog.user?.email}</strong>? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          {deleteUserMutation.error && (
            <Alert variant="destructive">
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>
                {deleteUserMutation.error.message}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialog({ isOpen: false, user: null })}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteDialog.user &&
                deleteUserMutation.mutate(deleteDialog.user.id)
              }
              disabled={deleteUserMutation.isPending}
            >
              {deleteUserMutation.isPending ? (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog
        open={resetDialog.isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setResetDialog({ isOpen: false, user: null, tempPassword: null });
            setCopied(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              {resetDialog.tempPassword
                ? "The temporary password has been generated. Share it with the user securely."
                : `Generate a new temporary password for ${resetDialog.user?.email}? They will be required to change it on their next login.`}
            </DialogDescription>
          </DialogHeader>

          {resetPasswordMutation.error && (
            <Alert variant="destructive">
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>
                {resetPasswordMutation.error.message}
              </AlertDescription>
            </Alert>
          )}

          {resetDialog.tempPassword && (
            <div className="flex items-center gap-2 rounded-md border p-3 bg-muted">
              <code className="flex-1 text-sm font-mono break-all">
                {resetDialog.tempPassword}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  handleCopyPassword(resetDialog.tempPassword!)
                }
              >
                {copied ? (
                  <IconCheck className="h-4 w-4 text-green-500" />
                ) : (
                  <IconCopy className="h-4 w-4" />
                )}
              </Button>
            </div>
          )}

          <DialogFooter>
            {resetDialog.tempPassword ? (
              <Button
                onClick={() => {
                  setResetDialog({
                    isOpen: false,
                    user: null,
                    tempPassword: null,
                  });
                  setCopied(false);
                }}
              >
                Done
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    setResetDialog({
                      isOpen: false,
                      user: null,
                      tempPassword: null,
                    })
                  }
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    resetDialog.user &&
                    resetPasswordMutation.mutate(resetDialog.user.id)
                  }
                  disabled={resetPasswordMutation.isPending}
                >
                  {resetPasswordMutation.isPending ? (
                    <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Reset Password
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
