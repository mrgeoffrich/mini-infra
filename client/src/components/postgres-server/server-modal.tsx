import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { PostgresServerInfo } from "@mini-infra/types";
import { POSTGRES_SSL_MODES } from "@mini-infra/types";
import { toast } from "sonner";
import {
  useCreatePostgresServer,
  useUpdatePostgresServer,
  useTestServerConnection,
} from "@/hooks/use-postgres-servers";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconSettingsQuestion,
  IconCircleCheck,
  IconAlertCircle,
  IconChevronDown,
} from "@tabler/icons-react";

// Validation schemas
const createServerSchema = z.object({
  name: z.string().min(1, "Server name is required"),
  host: z.string().min(1, "Host is required"),
  port: z.number().min(1).max(65535),
  adminUsername: z.string().min(1, "Admin username is required"),
  adminPassword: z.string().min(1, "Admin password is required"),
  sslMode: z.enum(POSTGRES_SSL_MODES),
  tags: z.string().optional(),
  linkedContainerId: z.string().optional(),
  linkedContainerName: z.string().optional(),
});

const updateServerSchema = z.object({
  name: z.string().min(1, "Server name is required"),
  host: z.string().min(1, "Host is required"),
  port: z.number().min(1).max(65535),
  adminUsername: z.string().min(1, "Admin username is required"),
  adminPassword: z.string().optional(), // Optional for updates
  sslMode: z.enum(POSTGRES_SSL_MODES),
  tags: z.string().optional(),
  linkedContainerId: z.string().optional(),
  linkedContainerName: z.string().optional(),
});

type ServerFormData = z.infer<typeof updateServerSchema>;

interface ServerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  serverId?: string; // Required for edit mode
  serverData?: PostgresServerInfo; // Server data for edit mode
  initialValues?: Partial<ServerFormData>; // Initial values for create mode
}

interface TestResult {
  success: boolean;
  message: string;
  version?: string;
}

export function ServerModal({ open, onOpenChange, mode, serverId, serverData, initialValues }: ServerModalProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Mutations
  const createServerMutation = useCreatePostgresServer();
  const updateServerMutation = useUpdatePostgresServer();
  const testConnectionMutation = useTestServerConnection();

  // Fetch PostgreSQL containers for linking
  const { data: postgresContainers } = useQuery<Array<{ id: string; name: string; image: string; imageTag: string }>>({
    queryKey: ["postgres-containers"],
    queryFn: async () => {
      const response = await fetch("/api/containers/postgres", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch PostgreSQL containers");
      const data = await response.json();
      return data.data || [];
    },
    enabled: open, // Only fetch when modal is open
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<ServerFormData>({
    resolver: zodResolver(mode === "edit" ? updateServerSchema : createServerSchema),
    defaultValues: {
      name: "",
      host: "",
      port: 5432,
      adminUsername: "postgres",
      adminPassword: "",
      sslMode: "prefer",
      tags: "",
    },
  });

  const sslMode = watch("sslMode");
  const formData = watch();

  // Pre-fill form when in edit mode or when initial values provided
  useEffect(() => {
    if (mode === "edit" && serverData && open) {
      reset({
        name: serverData.name,
        host: serverData.host,
        port: serverData.port,
        adminUsername: serverData.adminUsername,
        adminPassword: "", // Don't pre-fill password for security
        sslMode: serverData.sslMode as "prefer" | "require" | "disable",
        tags: serverData.tags?.join(", ") || "",
        linkedContainerId: serverData.linkedContainerId || "",
        linkedContainerName: serverData.linkedContainerName || "",
      });
      setTestResult(null);
    } else if (mode === "create" && open) {
      // Use initialValues if provided, otherwise use defaults
      reset({
        name: initialValues?.name || "",
        host: initialValues?.host || "",
        port: initialValues?.port || 5432,
        adminUsername: initialValues?.adminUsername || "postgres",
        adminPassword: initialValues?.adminPassword || "",
        sslMode: initialValues?.sslMode || "prefer",
        linkedContainerId: initialValues?.linkedContainerId || "",
        linkedContainerName: initialValues?.linkedContainerName || "",
        tags: initialValues?.tags || "",
      });
      setTestResult(null);
    }
  }, [mode, serverData, open, reset, initialValues]);

  const handleTestConnection = async () => {
    setTestResult(null);

    // Get current form values
    const { host, port, adminUsername, adminPassword, sslMode } = formData;

    // Validate required fields for test connection
    if (!host || !adminUsername || !adminPassword) {
      setTestResult({
        success: false,
        message: "Please fill in host, username, and password to test connection",
      });
      return;
    }

    try {
      const result = await testConnectionMutation.mutateAsync({
        host,
        port,
        username: adminUsername,
        password: adminPassword,
        sslMode,
      });

      setTestResult({
        success: result.success,
        message: result.success ? result.message || "Connection successful!" : result.error || "Connection failed",
        version: result.version,
      });
    } catch (error) {
      setTestResult({
        success: false,
        message: (error instanceof Error ? error.message : String(error)) || "Failed to test connection",
      });
    }
  };

  const onSubmit = async (data: ServerFormData) => {
    try {
      // Parse tags from comma-separated string
      const tags = data.tags
        ? data.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
        : [];

      if (mode === "create") {
        const response = await createServerMutation.mutateAsync({
          name: data.name,
          host: data.host,
          port: data.port,
          adminUsername: data.adminUsername,
          adminPassword: data.adminPassword || "", // In create mode, this will always be present due to validation
          sslMode: data.sslMode,
          tags,
          linkedContainerId: data.linkedContainerId || undefined,
          linkedContainerName: data.linkedContainerName || undefined,
        });

        // Display sync results
        if (response.data) {
          const { syncResults } = response.data;
          const dbSyncSuccess = syncResults.databasesSync.success;
          const userSyncSuccess = syncResults.usersSync.success;
          const dbCount = syncResults.databasesSync.count;
          const userCount = syncResults.usersSync.count;

          // Build a detailed success message
          const messages = [`Server added successfully`];

          if (dbSyncSuccess) {
            messages.push(`Synced ${dbCount} database${dbCount !== 1 ? "s" : ""}`);
          } else if (syncResults.databasesSync.error) {
            messages.push(`Database sync failed: ${syncResults.databasesSync.error}`);
          }

          if (userSyncSuccess) {
            messages.push(`Synced ${userCount} user${userCount !== 1 ? "s" : ""}`);
          } else if (syncResults.usersSync.error) {
            messages.push(`User sync failed: ${syncResults.usersSync.error}`);
          }

          if (dbSyncSuccess && userSyncSuccess) {
            toast.success(messages.join(" • "), { duration: 5000 });
          } else if (!dbSyncSuccess || !userSyncSuccess) {
            toast.warning(messages.join(" • "), { duration: 7000 });
          }
        } else {
          toast.success("Server added successfully");
        }
      } else if (mode === "edit" && serverId) {
        // Build update payload - only include fields that are provided
        const updatePayload: Record<string, unknown> = {
          name: data.name,
          host: data.host,
          port: data.port,
          adminUsername: data.adminUsername,
          sslMode: data.sslMode,
          tags,
          linkedContainerId: data.linkedContainerId || null,
          linkedContainerName: data.linkedContainerName || null,
        };

        // Only include password if it was entered (not empty)
        if (data.adminPassword) {
          updatePayload.adminPassword = data.adminPassword;
        }

        await updateServerMutation.mutateAsync({
          id: serverId,
          updates: updatePayload,
        });

        toast.success("Server updated successfully");
      }

      // Reset form and close modal
      reset();
      setTestResult(null);
      onOpenChange(false);
    } catch (error) {
      toast.error((error instanceof Error ? error.message : String(error)) || "Failed to save server");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add PostgreSQL Server" : "Edit PostgreSQL Server"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Connect to a PostgreSQL server with admin credentials"
              : "Update server connection details"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4 py-4">
            {/* Server Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Server Name *</Label>
              <Input
                id="name"
                placeholder="Production Database Server"
                {...register("name")}
              />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>

            {/* Connection Details */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="host">Host *</Label>
                <Input id="host" placeholder="localhost" {...register("host")} />
                {errors.host && (
                  <p className="text-sm text-destructive">{errors.host.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="port">Port *</Label>
                <Input
                  id="port"
                  type="number"
                  placeholder="5432"
                  {...register("port", { valueAsNumber: true })}
                />
                {errors.port && (
                  <p className="text-sm text-destructive">{errors.port.message}</p>
                )}
              </div>
            </div>

            {/* Admin Credentials */}
            <div className="space-y-2">
              <Label htmlFor="adminUsername">Admin Username *</Label>
              <Input
                id="adminUsername"
                placeholder="postgres"
                autoComplete="username"
                {...register("adminUsername")}
              />
              {errors.adminUsername && (
                <p className="text-sm text-destructive">{errors.adminUsername.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="adminPassword">
                Admin Password {mode === "create" && "*"}
                {mode === "edit" && <span className="text-muted-foreground font-normal">(optional)</span>}
              </Label>
              <div className="relative">
                <Input
                  id="adminPassword"
                  type={showPassword ? "text" : "password"}
                  placeholder={mode === "edit" ? "Leave blank to keep current password" : "••••••••"}
                  autoComplete="current-password"
                  {...register("adminPassword")}
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
              {errors.adminPassword && (
                <p className="text-sm text-destructive">{errors.adminPassword.message}</p>
              )}
            </div>

            {/* SSL Mode */}
            <div className="space-y-2">
              <Label htmlFor="sslMode">SSL Mode</Label>
              <Select
                value={sslMode}
                onValueChange={(value) => setValue("sslMode", value as "prefer" | "require" | "disable")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="prefer">Prefer (recommended)</SelectItem>
                  <SelectItem value="require">Require</SelectItem>
                  <SelectItem value="disable">Disable</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                "Prefer" attempts SSL first, falls back to non-SSL if unavailable
              </p>
            </div>

            {/* Advanced Options (Collapsible) */}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full justify-between" type="button">
                  <span>Advanced Options</span>
                  <IconChevronDown className="h-4 w-4" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-4">
                {/* Tags */}
                <div className="space-y-2">
                  <Label htmlFor="tags">Tags</Label>
                  <Input
                    id="tags"
                    placeholder="production, us-east, postgres-15"
                    {...register("tags")}
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated tags for organization
                  </p>
                </div>

                {/* Container Linking */}
                <div className="space-y-2">
                  <Label htmlFor="container">Link to Container (Optional)</Label>
                  <Select
                    value={watch("linkedContainerId") || "none"}
                    onValueChange={(value) => {
                      if (value === "none") {
                        setValue("linkedContainerId", "");
                        setValue("linkedContainerName", "");
                      } else {
                        const container = postgresContainers?.find((c) => c.id === value);
                        setValue("linkedContainerId", value);
                        setValue("linkedContainerName", container?.name || "");
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a PostgreSQL container" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {postgresContainers?.map((container) => (
                        <SelectItem key={container.id} value={container.id}>
                          {container.name} ({container.image}:{container.imageTag})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Link this server to a Docker PostgreSQL container for easy management
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Test Connection Result */}
            {testResult && (
              <Alert variant={testResult.success ? "default" : "destructive"}>
                {testResult.success ? (
                  <IconCircleCheck className="h-4 w-4" />
                ) : (
                  <IconAlertCircle className="h-4 w-4" />
                )}
                <AlertDescription>
                  {testResult.message}
                  {testResult.version && (
                    <div className="mt-1 text-xs">Version: {testResult.version}</div>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleTestConnection}
              disabled={testConnectionMutation.isPending}
            >
              {testConnectionMutation.isPending ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <IconSettingsQuestion className="h-4 w-4 mr-2" />
                  Test Connection
                </>
              )}
            </Button>
            <Button
              type="submit"
              disabled={createServerMutation.isPending || updateServerMutation.isPending}
            >
              {(createServerMutation.isPending || updateServerMutation.isPending) ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  {mode === "create" ? "Adding..." : "Saving..."}
                </>
              ) : (
                <>{mode === "create" ? "Add Server" : "Save Changes"}</>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
