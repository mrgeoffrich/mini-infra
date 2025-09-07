import { useState } from "react";
import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
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
  useCreatePostgresDatabase,
  useUpdatePostgresDatabase,
  useTestDatabaseConnection,
} from "@/hooks/use-postgres-databases";
import { Eye, EyeOff, TestTube, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { postgresDbSchema, type PostgresDbFormData } from "./schemas";
import type {
  PostgresDatabaseInfo,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  PostgreSSLMode,
} from "@mini-infra/types";

interface DatabaseModalProps {
  database?: PostgresDatabaseInfo;
  isOpen: boolean;
  onClose: () => void;
}

export function DatabaseModal({ database, isOpen, onClose }: DatabaseModalProps) {
  const [showPassword, setShowPassword] = useState(false);
  const isEditing = !!database;

  const createMutation = useCreatePostgresDatabase();
  const updateMutation = useUpdatePostgresDatabase();
  const testConnectionMutation = useTestDatabaseConnection();

  const form = useForm<PostgresDbFormData>({
    resolver: zodResolver(postgresDbSchema),
    defaultValues: {
      name: "",
      host: "",
      port: 5432,
      database: "",
      username: "",
      password: "",
      sslMode: "prefer",
      tags: [],
    },
    mode: "onChange",
  });

  // Reset form with database values when modal opens or database changes
  React.useEffect(() => {
    if (isOpen) {
      form.reset({
        name: database?.name || "",
        host: database?.host || "",
        port: database?.port || 5432,
        database: database?.database || "",
        username: database?.username || "",
        password: "",
        sslMode: (database?.sslMode as PostgreSSLMode) || "prefer",
        tags: database?.tags || [],
      });
    }
  }, [isOpen, database, form]);

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
        }`
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
        toast.error(
          `Connection test failed: ${result.data.error || result.message}`
        );
      }
    } catch (error) {
      toast.error(
        `Connection test failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
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