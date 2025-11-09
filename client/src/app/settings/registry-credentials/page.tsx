import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useRegistryCredentials,
  useCreateRegistryCredential,
  useUpdateRegistryCredential,
  useDeleteRegistryCredential,
  useSetDefaultCredential,
  useTestRegistryCredential,
} from "@/hooks/use-registry-credentials";
import {
  IconAlertCircle,
  IconDeviceFloppy,
  IconLoader2,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconEdit,
  IconTrash,
  IconFlask,
  IconStar,
  IconStarOff,
  IconKey,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import type { RegistryCredential } from "@mini-infra/types";

// Validation schema for registry credentials
const credentialSchema = z.object({
  name: z.string().min(1, "Name is required"),
  registryUrl: z.string().min(1, "Registry URL is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
});

type CredentialFormData = z.infer<typeof credentialSchema>;

export default function RegistryCredentialsPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit" | null>(null);
  const [selectedCredential, setSelectedCredential] = useState<RegistryCredential | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [credentialToDelete, setCredentialToDelete] = useState<RegistryCredential | null>(null);
  const [testingCredential, setTestingCredential] = useState<string | null>(null);

  // Fetch registry credentials
  const {
    data: credentialsData,
    isLoading: credentialsLoading,
    error: credentialsError,
    refetch: refetchCredentials,
  } = useRegistryCredentials();

  // Mutations
  const createCredential = useCreateRegistryCredential();
  const updateCredential = useUpdateRegistryCredential();
  const deleteCredential = useDeleteRegistryCredential();
  const setDefaultCredential = useSetDefaultCredential();
  const testCredential = useTestRegistryCredential();

  // Form setup
  const form = useForm<CredentialFormData>({
    resolver: zodResolver(credentialSchema),
    defaultValues: {
      name: "",
      registryUrl: "",
      username: "",
      password: "",
      isDefault: false,
      isActive: true,
      description: "",
    },
  });

  const handleOpenDialog = (mode: "create" | "edit", credential?: RegistryCredential) => {
    setDialogMode(mode);

    if (mode === "edit" && credential) {
      setSelectedCredential(credential);
      form.reset({
        name: credential.name,
        registryUrl: credential.registryUrl,
        username: credential.username,
        password: "", // Don't pre-fill password for security
        isDefault: credential.isDefault,
        isActive: credential.isActive,
        description: credential.description || "",
      });
    } else {
      setSelectedCredential(null);
      form.reset({
        name: "",
        registryUrl: "",
        username: "",
        password: "",
        isDefault: false,
        isActive: true,
        description: "",
      });
    }

    setShowPassword(false);
  };

  const handleCloseDialog = () => {
    setDialogMode(null);
    setSelectedCredential(null);
    form.reset();
    setShowPassword(false);
  };

  const handleSubmit = async (data: CredentialFormData) => {
    try {
      if (dialogMode === "create") {
        await createCredential.mutateAsync(data);
        toastWithCopy.success("Registry credential created successfully");
      } else if (dialogMode === "edit" && selectedCredential) {
        // Only include password if it was changed
        const updateData: any = {
          name: data.name,
          username: data.username,
          isDefault: data.isDefault,
          isActive: data.isActive,
          description: data.description,
        };

        if (data.password) {
          updateData.password = data.password;
        }

        await updateCredential.mutateAsync({
          id: selectedCredential.id,
          credential: updateData,
        });
        toastWithCopy.success("Registry credential updated successfully");
      }

      handleCloseDialog();
      refetchCredentials();
    } catch (error) {
      console.error("Failed to save registry credential:", error);
      toastWithCopy.error(
        error instanceof Error ? error.message : "Failed to save registry credential"
      );
    }
  };

  const handleDelete = async () => {
    if (!credentialToDelete) return;

    try {
      await deleteCredential.mutateAsync(credentialToDelete.id);
      toastWithCopy.success("Registry credential deleted successfully");
      setDeleteDialogOpen(false);
      setCredentialToDelete(null);
      refetchCredentials();
    } catch (error) {
      console.error("Failed to delete registry credential:", error);
      toastWithCopy.error(
        error instanceof Error ? error.message : "Failed to delete registry credential"
      );
    }
  };

  const handleSetDefault = async (credential: RegistryCredential) => {
    try {
      await setDefaultCredential.mutateAsync(credential.id);
      toastWithCopy.success(`${credential.name} set as default registry`);
      refetchCredentials();
    } catch (error) {
      console.error("Failed to set default credential:", error);
      toastWithCopy.error(
        error instanceof Error ? error.message : "Failed to set default credential"
      );
    }
  };

  const handleTestConnection = async (credential: RegistryCredential) => {
    setTestingCredential(credential.id);
    try {
      const result = await testCredential.mutateAsync(credential.id);

      const successMessage = `${result.data.message}${result.data.pullTimeMs ? ` (${result.data.pullTimeMs}ms)` : ""}`;
      toastWithCopy.success(successMessage, {
        title: "Connection Test Successful",
        description: `Registry: ${result.data.registryUrl}`,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to test registry connection";
      toastWithCopy.error(errorMessage, {
        title: "Connection Test Failed",
        description: "Copy the error details for troubleshooting",
      });
    } finally {
      setTestingCredential(null);
    }
  };

  if (credentialsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
              <IconKey className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Registry Credentials</h1>
              <p className="text-muted-foreground">
                Manage Docker registry authentication
              </p>
            </div>
          </div>

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load registry credentials. Please try refreshing the page.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const credentials = credentialsData?.data || [];

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
              <IconKey className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Registry Credentials</h1>
              <p className="text-muted-foreground">
                Manage Docker registry authentication for deployments and operations
              </p>
            </div>
          </div>

          <Button onClick={() => handleOpenDialog("create")}>
            <IconPlus className="h-4 w-4 mr-2" />
            Add Credential
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Registry Credentials</CardTitle>
            <CardDescription>
              Configure authentication for Docker registries. Credentials are automatically
              applied to container pulls, deployments, backups, and restores.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {credentialsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : credentials.length === 0 ? (
              <div className="text-center py-12">
                <IconKey className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No credentials configured</h3>
                <p className="text-muted-foreground mb-4">
                  Add your first Docker registry credential to enable authentication
                </p>
                <Button onClick={() => handleOpenDialog("create")}>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Add Credential
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Registry URL</TableHead>
                    <TableHead>Username</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {credentials.map((credential) => (
                    <TableRow key={credential.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {credential.name}
                          {credential.isDefault && (
                            <Badge variant="secondary" className="ml-2">
                              <IconStar className="h-3 w-3 mr-1" />
                              Default
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{credential.registryUrl}</TableCell>
                      <TableCell>{credential.username}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant={credential.isActive ? "default" : "secondary"}>
                            {credential.isActive ? "Active" : "Inactive"}
                          </Badge>
                          {credential.validationStatus && (
                            <Badge
                              variant={
                                credential.validationStatus === "valid"
                                  ? "default"
                                  : credential.validationStatus === "invalid"
                                  ? "destructive"
                                  : "secondary"
                              }
                            >
                              {credential.validationStatus}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleTestConnection(credential)}
                            disabled={testingCredential === credential.id}
                          >
                            {testingCredential === credential.id ? (
                              <IconLoader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <IconFlask className="h-4 w-4" />
                            )}
                          </Button>

                          {!credential.isDefault && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleSetDefault(credential)}
                              title="Set as default"
                            >
                              <IconStarOff className="h-4 w-4" />
                            </Button>
                          )}

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenDialog("edit", credential)}
                          >
                            <IconEdit className="h-4 w-4" />
                          </Button>

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setCredentialToDelete(credential);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <IconTrash className="h-4 w-4" />
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
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogMode !== null} onOpenChange={(open) => !open && handleCloseDialog()}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "create" ? "Add Registry Credential" : "Edit Registry Credential"}
            </DialogTitle>
            <DialogDescription>
              {dialogMode === "create"
                ? "Add a new Docker registry credential for authentication"
                : "Update the registry credential details"}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., GitHub Container Registry" {...field} />
                    </FormControl>
                    <FormDescription>
                      Friendly name to identify this credential
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="registryUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Registry URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g., ghcr.io, registry.hub.docker.com"
                        {...field}
                        disabled={dialogMode === "edit"}
                      />
                    </FormControl>
                    <FormDescription>
                      Docker registry hostname (cannot be changed after creation)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
                    <FormControl>
                      <Input placeholder="username" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Password {dialogMode === "edit" && "(leave empty to keep current)"}
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type={showPassword ? "text" : "password"}
                          placeholder={dialogMode === "edit" ? "••••••••" : "password"}
                          {...field}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="absolute right-0 top-0 h-full px-3"
                          onClick={() => setShowPassword(!showPassword)}
                        >
                          {showPassword ? (
                            <IconEyeOff className="h-4 w-4" />
                          ) : (
                            <IconEye className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </FormControl>
                    <FormDescription>
                      Password or personal access token (encrypted when stored)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description (Optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Additional notes about this credential"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex items-center gap-6">
                <FormField
                  control={form.control}
                  name="isDefault"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 space-y-0">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="!mt-0 cursor-pointer">
                        Set as default registry
                      </FormLabel>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="isActive"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 space-y-0">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="!mt-0 cursor-pointer">Active</FormLabel>
                    </FormItem>
                  )}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleCloseDialog}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createCredential.isPending || updateCredential.isPending}
                >
                  {(createCredential.isPending || updateCredential.isPending) ? (
                    <>
                      <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <IconDeviceFloppy className="h-4 w-4 mr-2" />
                      Save
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Registry Credential</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{credentialToDelete?.name}"? This action cannot
              be undone. Any deployments or operations using this registry will fail unless
              another credential is configured.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setCredentialToDelete(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteCredential.isPending ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
