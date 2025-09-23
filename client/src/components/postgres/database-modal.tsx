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
  useDiscoverDatabases,
} from "@/hooks/use-postgres-databases";
import { Eye, EyeOff, TestTube, Loader2, ArrowRight, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import {
  postgresDbSchema,
  postgresConnectionSchema,
  type PostgresDbFormData,
  type PostgresConnectionFormData
} from "./schemas";
import type {
  PostgresDatabaseInfo,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  PostgreSSLMode,
  DatabaseInfo,
} from "@mini-infra/types";

interface DatabaseModalProps {
  database?: PostgresDatabaseInfo;
  isOpen: boolean;
  onClose: () => void;
}

type ModalStep = "connection" | "database-selection" | "final-details";

export function DatabaseModal({
  database,
  isOpen,
  onClose,
}: DatabaseModalProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [currentStep, setCurrentStep] = useState<ModalStep>("connection");
  const [availableDatabases, setAvailableDatabases] = useState<DatabaseInfo[]>([]);
  const [connectionData, setConnectionData] = useState<PostgresConnectionFormData | null>(null);
  const [selectedDatabase, setSelectedDatabase] = useState<string>("");

  const isEditing = !!database;

  const createMutation = useCreatePostgresDatabase();
  const updateMutation = useUpdatePostgresDatabase();
  const testConnectionMutation = useTestDatabaseConnection();
  const discoverDatabasesMutation = useDiscoverDatabases();

  // Connection form for step 1
  const connectionForm = useForm<PostgresConnectionFormData>({
    resolver: zodResolver(postgresConnectionSchema),
    defaultValues: {
      host: "",
      port: 5432,
      username: "",
      password: "",
      sslMode: "prefer",
    },
    mode: "onChange",
  });

  // Final form for step 3
  const finalForm = useForm<PostgresDbFormData>({
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

  // Reset forms and step when modal opens or database changes
  React.useEffect(() => {
    if (isOpen) {
      if (isEditing) {
        // For editing, skip to final step and populate all data
        setCurrentStep("final-details");
        finalForm.reset({
          name: database?.name || "",
          host: database?.host || "",
          port: database?.port || 5432,
          database: database?.database || "",
          username: database?.username || "",
          password: "",
          sslMode: (database?.sslMode as PostgreSSLMode) || "prefer",
          tags: database?.tags || [],
        });
      } else {
        // For creating, start from step 1
        setCurrentStep("connection");
        setConnectionData(null);
        setAvailableDatabases([]);
        setSelectedDatabase("");
        connectionForm.reset({
          host: "",
          port: 5432,
          username: "",
          password: "",
          sslMode: "prefer",
        });
        finalForm.reset({
          name: "",
          host: "",
          port: 5432,
          database: "",
          username: "",
          password: "",
          sslMode: "prefer",
          tags: [],
        });
      }
    }
  }, [isOpen, database, connectionForm, finalForm, isEditing]);

  const handleConnectionTest = async () => {
    const formData = connectionForm.getValues();

    try {
      // Discover databases using the connection details
      const result = await discoverDatabasesMutation.mutateAsync(formData);

      if (result.data.databases.length === 0) {
        toast.warning("No databases found on this server");
        return;
      }

      // Store connection data and move to database selection
      setConnectionData(formData);
      setAvailableDatabases(result.data.databases);
      setCurrentStep("database-selection");
      toast.success(`Connected successfully! Found ${result.data.databases.length} database(s)`);
    } catch (error) {
      toast.error(
        `Connection failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleDatabaseSelection = () => {
    if (!selectedDatabase || !connectionData) {
      toast.error("Please select a database");
      return;
    }

    // Populate final form with connection data and selected database
    finalForm.reset({
      name: `${connectionData.host}-${selectedDatabase}`,
      host: connectionData.host,
      port: connectionData.port,
      database: selectedDatabase,
      username: connectionData.username,
      password: connectionData.password,
      sslMode: connectionData.sslMode,
      tags: [],
    });

    setCurrentStep("final-details");
  };

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

  const testFinalConnection = async () => {
    const formData = finalForm.getValues();
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
          `Connection test failed: ${result.data.error || result.message}`,
        );
      }
    } catch (error) {
      toast.error(
        `Connection test failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleBack = () => {
    if (currentStep === "database-selection") {
      setCurrentStep("connection");
    } else if (currentStep === "final-details" && !isEditing) {
      setCurrentStep("database-selection");
    }
  };

  const getModalTitle = () => {
    if (isEditing) return "Edit Database";

    switch (currentStep) {
      case "connection":
        return "Add New Database - Connection";
      case "database-selection":
        return "Add New Database - Select Database";
      case "final-details":
        return "Add New Database - Final Details";
      default:
        return "Add New Database";
    }
  };

  const getModalDescription = () => {
    if (isEditing) return "Update the database configuration.";

    switch (currentStep) {
      case "connection":
        return "Enter the connection details to connect to your PostgreSQL server.";
      case "database-selection":
        return "Select which database you want to configure from the available databases.";
      case "final-details":
        return "Review and finalize your database configuration.";
      default:
        return "Add a new PostgreSQL database configuration.";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{getModalTitle()}</DialogTitle>
          <DialogDescription>{getModalDescription()}</DialogDescription>
        </DialogHeader>

        {/* Step 1: Connection Details */}
        {currentStep === "connection" && (
          <Form {...connectionForm}>
            <form onSubmit={connectionForm.handleSubmit(handleConnectionTest)} className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <FormField
                    control={connectionForm.control}
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
                  control={connectionForm.control}
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
                  control={connectionForm.control}
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

                <FormField
                  control={connectionForm.control}
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

              <FormField
                control={connectionForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type={showPassword ? "text" : "password"}
                          placeholder="Enter password"
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

              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={discoverDatabasesMutation.isPending}
                >
                  {discoverDatabasesMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <ArrowRight className="w-4 h-4 mr-2" />
                  )}
                  Connect & Discover
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}

        {/* Step 2: Database Selection */}
        {currentStep === "database-selection" && (
          <div className="space-y-4">
            <div className="space-y-3">
              <FormLabel>Select Database</FormLabel>
              <div className="max-h-60 overflow-y-auto space-y-2">
                {availableDatabases.map((db) => (
                  <div
                    key={db.name}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedDatabase === db.name
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/50"
                    }`}
                    onClick={() => setSelectedDatabase(db.name)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{db.name}</div>
                        {db.description && (
                          <div className="text-sm text-muted-foreground">
                            {db.description}
                          </div>
                        )}
                      </div>
                      {db.sizePretty && (
                        <div className="text-sm text-muted-foreground">
                          {db.sizePretty}
                        </div>
                      )}
                    </div>
                    {(db.encoding || db.collation) && (
                      <div className="text-xs text-muted-foreground mt-1">
                        {db.encoding && `Encoding: ${db.encoding}`}
                        {db.encoding && db.collation && " • "}
                        {db.collation && `Collation: ${db.collation}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleBack}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
              <Button
                onClick={handleDatabaseSelection}
                disabled={!selectedDatabase}
              >
                <ArrowRight className="w-4 h-4 mr-2" />
                Continue
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3: Final Details */}
        {currentStep === "final-details" && (
          <Form {...finalForm}>
            <form onSubmit={finalForm.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={finalForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Configuration Name</FormLabel>
                      <FormControl>
                        <Input placeholder="my-database" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={finalForm.control}
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
                    control={finalForm.control}
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
                  control={finalForm.control}
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
                  control={finalForm.control}
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
                  control={finalForm.control}
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
                control={finalForm.control}
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
                  onClick={testFinalConnection}
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
                {!isEditing && (
                  <Button type="button" variant="outline" onClick={handleBack}>
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back
                  </Button>
                )}
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
        )}
      </DialogContent>
    </Dialog>
  );
}
