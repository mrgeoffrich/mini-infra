import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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

// Validation schema
const serverSchema = z.object({
  name: z.string().min(1, "Server name is required"),
  host: z.string().min(1, "Host is required"),
  port: z.number().min(1).max(65535),
  adminUsername: z.string().min(1, "Admin username is required"),
  adminPassword: z.string().min(1, "Admin password is required"),
  sslMode: z.enum(["prefer", "require", "disable"]),
  tags: z.string().optional(),
});

type ServerFormData = z.infer<typeof serverSchema>;

interface ServerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  serverId?: string; // Required for edit mode
}

interface TestResult {
  success: boolean;
  message: string;
  version?: string;
}

export function ServerModal({ open, onOpenChange, mode, serverId: _serverId }: ServerModalProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Mutations
  const createServerMutation = useCreatePostgresServer();
  const updateServerMutation = useUpdatePostgresServer();
  const testConnectionMutation = useTestServerConnection();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<ServerFormData>({
    resolver: zodResolver(serverSchema),
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
    } catch (error: any) {
      setTestResult({
        success: false,
        message: error.message || "Failed to test connection",
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
          adminPassword: data.adminPassword,
          sslMode: data.sslMode,
          tags,
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
      } else {
        // TODO: Implement update when serverId is properly passed
        toast.info("Update functionality coming soon");
      }

      // Reset form and close modal
      reset();
      setTestResult(null);
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save server");
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
              <Label htmlFor="adminPassword">Admin Password *</Label>
              <div className="relative">
                <Input
                  id="adminPassword"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
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
