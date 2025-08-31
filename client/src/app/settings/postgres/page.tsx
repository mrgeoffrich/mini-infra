import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "react-router-dom";
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
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  usePostgresDatabases,
  useCreatePostgresDatabase,
  useUpdatePostgresDatabase,
  useDeletePostgresDatabase,
  useTestDatabaseConnection,
  useTestExistingDatabaseConnection,
  usePostgresDatabaseFilters,
} from "@/hooks/use-postgres-databases";
import {
  Database,
  CheckCircle,
  XCircle,
  AlertCircle,
  ArrowLeft,
  TestTube,
  Loader2,
  Eye,
  EyeOff,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import type {
  PostgresDatabaseInfo,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  DatabaseHealthStatus,
  PostgreSSLMode,
} from "@mini-infra/types";

const postgresDbSchema = z.object({
  name: z
    .string()
    .min(1, "Database name is required")
    .max(255, "Database name must be less than 255 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Database name can only contain letters, numbers, underscores, and hyphens",
    ),
  host: z
    .string()
    .min(1, "Host is required")
    .max(255, "Host must be less than 255 characters"),
  port: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  database: z
    .string()
    .min(1, "Database name is required")
    .max(255, "Database name must be less than 255 characters"),
  username: z
    .string()
    .min(1, "Username is required")
    .max(255, "Username must be less than 255 characters"),
  password: z
    .string()
    .min(1, "Password is required")
    .max(255, "Password must be less than 255 characters"),
  sslMode: z.enum(["require", "disable", "prefer"]),
  tags: z.array(z.string()),
});

type PostgresDbFormData = z.infer<typeof postgresDbSchema>;

function HealthStatusBadge({ status }: { status: DatabaseHealthStatus }) {
  switch (status) {
    case "healthy":
      return (
        <Badge variant="outline" className="text-green-700 border-green-200">
          <CheckCircle className="w-3 h-3 mr-1" />
          Healthy
        </Badge>
      );
    case "unhealthy":
      return (
        <Badge variant="outline" className="text-red-700 border-red-200">
          <XCircle className="w-3 h-3 mr-1" />
          Unhealthy
        </Badge>
      );
    case "unknown":
    default:
      return (
        <Badge variant="outline" className="text-gray-700 border-gray-200">
          <AlertCircle className="w-3 h-3 mr-1" />
          Unknown
        </Badge>
      );
  }
}

function DatabaseModal({
  database,
  isOpen,
  onClose,
}: {
  database?: PostgresDatabaseInfo;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const isEditing = !!database;

  const createMutation = useCreatePostgresDatabase();
  const updateMutation = useUpdatePostgresDatabase();
  const testConnectionMutation = useTestDatabaseConnection();

  const form = useForm<PostgresDbFormData>({
    resolver: zodResolver(postgresDbSchema),
    defaultValues: {
      name: database?.name || "",
      host: database?.host || "",
      port: database?.port || 5432,
      database: database?.database || "",
      username: database?.username || "",
      password: "",
      sslMode: (database?.sslMode as PostgreSSLMode) || "prefer",
      tags: database?.tags || [],
    },
    mode: "onChange",
  });

  const onSubmit = async (data: PostgresDbFormData) => {
    try {
      if (isEditing) {
        const updateData: UpdatePostgresDatabaseRequest = {
          ...data,
          password: data.password || undefined,
        };
        await updateMutation.mutateAsync({
          id: database.id,
          request: updateData,
        });
        toast.success("Database updated successfully");
      } else {
        const createData: CreatePostgresDatabaseRequest = data;
        await createMutation.mutateAsync(createData);
        toast.success("Database created successfully");
      }
      onClose();
    } catch (error) {
      toast.error(
        `Failed to ${isEditing ? "update" : "create"} database: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const testConnection = async () => {
    const formData = form.getValues();
    if (!formData.password && isEditing) {
      toast.error("Password is required to test connection");
      return;
    }

    try {
      const testData = {
        host: formData.host,
        port: formData.port,
        database: formData.database,
        username: formData.username,
        password: formData.password,
        sslMode: formData.sslMode,
      };
      const result = await testConnectionMutation.mutateAsync(testData);
      if (result.data.isConnected) {
        toast.success("Connection test successful!");
      } else {
        toast.error(`Connection test failed: ${result.data.error || result.message}`);
      }
    } catch (error) {
      toast.error(
        `Connection test failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Database" : "Add New Database"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the database configuration."
              : "Add a new PostgreSQL database configuration."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Database Name</FormLabel>
                    <FormControl>
                      <Input placeholder="my-database" {...field} />
                    </FormControl>
                    <FormDescription>
                      A unique name for this database configuration
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sslMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>SSL Mode</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select SSL mode" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="require">Require</SelectItem>
                        <SelectItem value="prefer">Prefer</SelectItem>
                        <SelectItem value="disable">Disable</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <FormField
                  control={form.control}
                  name="host"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Host</FormLabel>
                      <FormControl>
                        <Input placeholder="localhost" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="5432"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="database"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Database</FormLabel>
                    <FormControl>
                      <Input placeholder="postgres" {...field} />
                    </FormControl>
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
                      <Input placeholder="postgres" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Password {isEditing && "(leave empty to keep current)"}
                  </FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder={
                          isEditing ? "Enter new password" : "Enter password"
                        }
                        {...field}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex items-center space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={testConnection}
                disabled={testConnectionMutation.isPending}
              >
                {testConnectionMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="w-4 h-4 mr-2" />
                )}
                Test Connection
              </Button>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  createMutation.isPending ||
                  updateMutation.isPending ||
                  testConnectionMutation.isPending
                }
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                {isEditing ? "Update" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function PostgresSettingsPage() {
  const [selectedDatabase, setSelectedDatabase] =
    useState<PostgresDatabaseInfo | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [databaseToDelete, setDatabaseToDelete] =
    useState<PostgresDatabaseInfo | null>(null);

  const { filters } = usePostgresDatabaseFilters();

  const {
    data: databasesResponse,
    isLoading,
    error,
  } = usePostgresDatabases({
    filters: {
      name: filters.name,
      host: filters.host,
      healthStatus: filters.healthStatus,
      tags: filters.tags,
    },
    page: filters.page,
    limit: filters.limit,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  const deleteMutation = useDeletePostgresDatabase();
  const testExistingMutation = useTestExistingDatabaseConnection();

  const databases = databasesResponse?.data || [];

  const openCreateModal = () => {
    setSelectedDatabase(null);
    setIsModalOpen(true);
  };

  const openEditModal = (database: PostgresDatabaseInfo) => {
    setSelectedDatabase(database);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setSelectedDatabase(null);
  };

  const openDeleteDialog = (database: PostgresDatabaseInfo) => {
    setDatabaseToDelete(database);
    setIsDeleteDialogOpen(true);
  };

  const closeDeleteDialog = () => {
    setIsDeleteDialogOpen(false);
    setDatabaseToDelete(null);
  };

  const confirmDelete = async () => {
    if (!databaseToDelete) return;

    try {
      await deleteMutation.mutateAsync(databaseToDelete.id);
      toast.success("Database deleted successfully");
      closeDeleteDialog();
    } catch (error) {
      toast.error(
        `Failed to delete database: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const testExistingConnection = async (database: PostgresDatabaseInfo) => {
    try {
      const result = await testExistingMutation.mutateAsync(database.id);
      if (result.data.isConnected) {
        toast.success(`Connection test successful for ${database.name}!`);
      } else {
        toast.error(
          `Connection test failed for ${database.name}: ${result.data.error || result.message}`,
        );
      }
    } catch (error) {
      toast.error(
        `Connection test failed for ${database.name}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  if (error) {
    return (
      <div className="container mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-8">
          <Link
            to="/settings"
            className="flex items-center text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Settings
          </Link>
        </div>

        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load PostgreSQL databases: {error.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center gap-4 mb-8">
        <Link
          to="/settings"
          className="flex items-center text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Settings
        </Link>
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">PostgreSQL Management</h1>
            <p className="text-muted-foreground">
              Configure and manage PostgreSQL database connections
            </p>
          </div>
          <Button onClick={openCreateModal}>
            <Plus className="w-4 h-4 mr-2" />
            Add Database
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Database className="w-5 h-5 mr-2" />
              Database Connections
            </CardTitle>
            <CardDescription>
              Manage your PostgreSQL database configurations and monitor their
              health status
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center space-x-4">
                    <Skeleton className="h-12 w-12" />
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-[200px]" />
                      <Skeleton className="h-4 w-[150px]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : databases.length === 0 ? (
              <div className="text-center py-8">
                <Database className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-semibold mb-2">
                  No databases configured
                </h3>
                <p className="text-muted-foreground mb-4">
                  Get started by adding your first PostgreSQL database
                  connection
                </p>
                <Button onClick={openCreateModal}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Database
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Database</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Check</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {databases.map((database) => (
                    <TableRow key={database.id}>
                      <TableCell className="font-medium">
                        {database.name}
                      </TableCell>
                      <TableCell>
                        {database.host}:{database.port}
                      </TableCell>
                      <TableCell>{database.database}</TableCell>
                      <TableCell>
                        <HealthStatusBadge status={database.healthStatus} />
                      </TableCell>
                      <TableCell>
                        {database.lastHealthCheck
                          ? format(
                              new Date(database.lastHealthCheck),
                              "MMM d, yyyy HH:mm",
                            )
                          : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => testExistingConnection(database)}
                            disabled={testExistingMutation.isPending}
                          >
                            {testExistingMutation.isPending ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <TestTube className="w-4 h-4" />
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditModal(database)}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openDeleteDialog(database)}
                          >
                            <Trash2 className="w-4 h-4" />
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

      <DatabaseModal
        database={selectedDatabase || undefined}
        isOpen={isModalOpen}
        onClose={closeModal}
      />

      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the database configuration for "
              {databaseToDelete?.name}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={closeDeleteDialog}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
