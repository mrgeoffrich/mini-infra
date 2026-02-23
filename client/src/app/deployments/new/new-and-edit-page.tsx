import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useCreateDeploymentConfig,
  useUpdateDeploymentConfig,
  useDeploymentConfig,
} from "@/hooks/use-deployment-configs";
import { useEnvironments } from "@/hooks/use-environments";
import {
  IconAlertCircle,
  IconLoader2,
  IconDeviceFloppy,
  IconBrandDocker,
  IconActivity,
  IconArrowLeft,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { EnvVarEditor } from "@/components/deployments/env-var-editor";
import { VolumeEditor } from "@/components/deployments/volume-editor";
import { HostnameFormField } from "@/components/deployments/hostname-input";
import type {
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  ContainerConfig,
  HealthCheckConfig,
  RollbackConfig,
} from "@mini-infra/types";

// Form data type that matches our form structure
interface DeploymentFormData {
  applicationName: string;
  dockerImage: string;
  dockerTag: string;
  dockerRegistry: string;
  hostname?: string;
  enableSsl?: boolean;
  environmentId: string;
  containerConfig: ContainerConfig;
  healthCheckConfig: HealthCheckConfig;
  rollbackConfig: RollbackConfig;
  listeningPort: number;
}

export function NewDeploymentConfigPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editId = searchParams.get("edit");

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("docker");
  const isEditing = !!editId;

  // Fetch deployment config for editing
  const {
    data: deploymentConfigResponse,
    isLoading: isLoadingConfig,
    error: configError,
  } = useDeploymentConfig(editId!, { enabled: isEditing });

  const deploymentConfig = deploymentConfigResponse?.data;

  // Fetch environments for selection
  const { data: environmentsResponse, isLoading: isLoadingEnvironments } =
    useEnvironments({
      filters: { limit: 100 }, // Get all environments
    });

  const environments = environmentsResponse?.environments || [];

  const createMutation = useCreateDeploymentConfig();
  const updateMutation = useUpdateDeploymentConfig();

  const form = useForm<DeploymentFormData>({
    defaultValues: {
      applicationName: "",
      dockerImage: "",
      dockerTag: "latest",
      dockerRegistry: "",
      hostname: "",
      enableSsl: false,
      environmentId: "",
      containerConfig: {
        ports: [],
        volumes: [],
        environment: [],
        labels: {},
        networks: [],
      },
      healthCheckConfig: {
        endpoint: "/health",
        method: "GET",
        expectedStatus: [200],
        responseValidation: undefined,
        timeout: 10000,
        retries: 3,
        interval: 5000,
      },
      rollbackConfig: {
        enabled: true,
        maxWaitTime: 300000,
        keepOldContainer: false,
      },
      listeningPort: 8080,
    },
    mode: "onChange",
  });

  // Update form when deployment config is loaded
  useEffect(() => {
    if (deploymentConfig) {
      form.reset({
        applicationName: deploymentConfig.applicationName || "",
        dockerImage: deploymentConfig.dockerImage || "",
        dockerTag: deploymentConfig.dockerTag || "latest",
        dockerRegistry: deploymentConfig.dockerRegistry || "",
        hostname: deploymentConfig.hostname || "",
        enableSsl: deploymentConfig.enableSsl || false,
        environmentId: deploymentConfig.environmentId || "",
        containerConfig: {
          ports: deploymentConfig.containerConfig?.ports || [],
          volumes: deploymentConfig.containerConfig?.volumes || [],
          environment: deploymentConfig.containerConfig?.environment || [],
          labels: deploymentConfig.containerConfig?.labels || {},
          networks: deploymentConfig.containerConfig?.networks || [],
        },
        healthCheckConfig: {
          endpoint: deploymentConfig.healthCheckConfig?.endpoint || "/health",
          method: deploymentConfig.healthCheckConfig?.method || "GET",
          expectedStatus: deploymentConfig.healthCheckConfig
            ?.expectedStatus || [200],
          responseValidation:
            deploymentConfig.healthCheckConfig?.responseValidation || undefined,
          timeout: deploymentConfig.healthCheckConfig?.timeout || 10000,
          retries: deploymentConfig.healthCheckConfig?.retries || 3,
          interval: deploymentConfig.healthCheckConfig?.interval || 5000,
        },
        rollbackConfig: {
          enabled: deploymentConfig.rollbackConfig?.enabled ?? true,
          maxWaitTime: deploymentConfig.rollbackConfig?.maxWaitTime || 300000,
          keepOldContainer:
            deploymentConfig.rollbackConfig?.keepOldContainer || false,
        },
        listeningPort: deploymentConfig.listeningPort || 8080,
      });
    }
  }, [deploymentConfig, form]);

  const onSubmit = async (data: any) => {
    setSubmitError(null);
    try {
      if (isEditing && deploymentConfig) {
        const updateData: UpdateDeploymentConfigRequest = {
          applicationName: data.applicationName,
          dockerImage: data.dockerImage,
          dockerTag: data.dockerTag || "latest",
          dockerRegistry: data.dockerRegistry,
          hostname: data.hostname || undefined,
          enableSsl: data.enableSsl,
          containerConfig: data.containerConfig,
          healthCheckConfig: data.healthCheckConfig,
          rollbackConfig: data.rollbackConfig,
          listeningPort: data.listeningPort,
        };
        await updateMutation.mutateAsync({
          id: deploymentConfig.id,
          request: updateData,
        });
        toast.success("Deployment configuration updated successfully");
      } else {
        const createData: CreateDeploymentConfigRequest = {
          applicationName: data.applicationName,
          dockerImage: data.dockerImage,
          dockerTag: data.dockerTag || "latest",
          dockerRegistry: data.dockerRegistry,
          hostname: data.hostname || undefined,
          enableSsl: data.enableSsl,
          environmentId: data.environmentId,
          containerConfig: data.containerConfig,
          healthCheckConfig: data.healthCheckConfig,
          rollbackConfig: data.rollbackConfig,
          listeningPort: data.listeningPort,
        };
        await createMutation.mutateAsync(createData);
        toast.success("Deployment configuration created successfully");
      }
      navigate("/deployments");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      setSubmitError(errorMessage);
    }
  };

  const handleBack = () => {
    navigate("/deployments");
  };

  const isLoading =
    createMutation.isPending || updateMutation.isPending || isLoadingConfig;

  if (isEditing && configError) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center p-8">
          <div className="text-center">
            <p className="text-muted-foreground">
              Failed to load deployment configuration
            </p>
            <p className="text-sm text-destructive mt-2">
              {configError instanceof Error
                ? configError.message
                : "Unknown error"}
            </p>
            <Button onClick={handleBack} className="mt-4">
              <IconArrowLeft className="h-4 w-4 mr-2" />
              Back to Deployments
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isEditing && isLoadingConfig) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center p-8">
          <IconLoader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <IconArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {isEditing
              ? "Edit Deployment Configuration"
              : "New Deployment Configuration"}
          </h1>
          <p className="text-muted-foreground">
            Configure deployment settings for your application including Docker,
            health checks, and rollback options.
          </p>
        </div>
      </div>

      {submitError && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="docker" className="flex items-center gap-2">
                <IconBrandDocker className="w-4 h-4" />
                Docker
              </TabsTrigger>
              <TabsTrigger value="health" className="flex items-center gap-2">
                <IconActivity className="w-4 h-4" />
                Health Check
              </TabsTrigger>
            </TabsList>

            <TabsContent value="docker" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <IconBrandDocker className="w-5 h-5 text-blue-500" />
                    Docker Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure the Docker image and container settings
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Environment and Application Name */}
                  <div className="grid grid-cols-2 gap-4 items-start">
                    <FormField
                      control={form.control}
                      name="environmentId"
                      render={({ field }) => (
                        <FormItem className="space-y-2">
                          <FormLabel>Environment</FormLabel>
                          <FormControl>
                            {isEditing ? (
                              <Input
                                value={
                                  environments.find((env) => env.id === field.value)?.name || ""
                                }
                                disabled
                                className="bg-muted"
                              />
                            ) : (
                              <Select
                                value={field.value}
                                onValueChange={field.onChange}
                                disabled={isLoadingEnvironments}
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue
                                    placeholder={
                                      isLoadingEnvironments
                                        ? "Loading environments..."
                                        : "Select an environment"
                                    }
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {environments
                                    .filter((env) => env.isActive)
                                    .map((environment) => (
                                      <SelectItem
                                        key={environment.id}
                                        value={environment.id}
                                      >
                                        {environment.name} ({environment.type})
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            )}
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="applicationName"
                      render={({ field }) => (
                        <FormItem className="space-y-2">
                          <FormLabel>Application Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="my-app"
                              {...field}
                              onChange={(e) => {
                                const value = e.target.value
                                  .toLowerCase()
                                  .replace(/[^a-z0-9-]/g, "-");
                                field.onChange(value);
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* Docker Registry, Image, and Tag */}
                  <div className="grid grid-cols-6 gap-4">
                    <div className="col-span-2">
                      <FormField
                        control={form.control}
                        name="dockerRegistry"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Docker Registry (Optional)</FormLabel>
                            <FormControl>
                              <Input placeholder="docker.io" {...field} />
                            </FormControl>
                            <FormDescription>
                              Docker registry URL (leave empty for Docker Hub)
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="col-span-3">
                      <FormField
                        control={form.control}
                        name="dockerImage"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Docker Image</FormLabel>
                            <FormControl>
                              <Input placeholder="nginx" {...field} />
                            </FormControl>
                            <FormDescription>
                              Docker image name (without tag)
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="dockerTag"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Tag</FormLabel>
                          <FormControl>
                            <Input placeholder="latest" {...field} />
                          </FormControl>
                          <FormDescription>Image tag</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="listeningPort"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Listening Port</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="1"
                            max="65535"
                            placeholder="8080"
                            {...field}
                            onChange={(e) => {
                              const value = e.target.value;
                              field.onChange(value ? Number(value) : 8080);
                            }}
                          />
                        </FormControl>
                        <FormDescription>
                          Port your application listens on for health checks and traffic routing.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="border-t pt-4 space-y-4">
                    <FormField
                      control={form.control}
                      name="hostname"
                      render={({ field }) => (
                        <HostnameFormField
                          field={{
                            value: field.value || "",
                            onChange: field.onChange,
                          }}
                          excludeConfigId={deploymentConfig?.id}
                          showValidateButton={true}
                          description="Public hostname for accessing your application (e.g., api.example.com). Click 'Validate' to check availability against Cloudflare and existing configurations."
                          placeholder="api.example.com"
                        />
                      )}
                    />

                    {form.watch("hostname") && (
                      <FormField
                        control={form.control}
                        name="enableSsl"
                        render={({ field }) => (
                          <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                            <div className="space-y-0.5">
                              <FormLabel className="text-base">
                                Enable SSL/TLS
                              </FormLabel>
                              <FormDescription>
                                Automatically provision and manage SSL certificate for this hostname
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Switch
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                </CardContent>
              </Card>

              <Tabs defaultValue="volumes" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="volumes">Volume Mounts</TabsTrigger>
                  <TabsTrigger value="environment">Environment Variables</TabsTrigger>
                </TabsList>
                <TabsContent value="volumes">
                  <VolumeEditor form={form} />
                </TabsContent>
                <TabsContent value="environment">
                  <EnvVarEditor form={form} />
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="health" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <IconActivity className="w-5 h-5 text-green-500" />
                    Health Check Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure health checks to ensure your application is ready
                    before switching traffic
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="healthCheckConfig.endpoint"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Health Check Endpoint</FormLabel>
                          <FormControl>
                            <Input placeholder="/health" {...field} />
                          </FormControl>
                          <FormDescription>
                            URL path or full URL for health check
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="healthCheckConfig.method"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>HTTP Method</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="GET">GET</SelectItem>
                              <SelectItem value="POST">POST</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormDescription>HTTP method to use</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="healthCheckConfig.responseValidation"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Response Validation Pattern (Optional)
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="OK|healthy" {...field} />
                        </FormControl>
                        <FormDescription>
                          Regex pattern to validate response body (optional)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-3 gap-4">
                    <FormField
                      control={form.control}
                      name="healthCheckConfig.timeout"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Timeout (ms)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="1000"
                              max="60000"
                              {...field}
                              onChange={(e) =>
                                field.onChange(Number(e.target.value))
                              }
                            />
                          </FormControl>
                          <FormDescription>Request timeout</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="healthCheckConfig.retries"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Retries</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              max="10"
                              {...field}
                              onChange={(e) =>
                                field.onChange(Number(e.target.value))
                              }
                            />
                          </FormControl>
                          <FormDescription>Retry attempts</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="healthCheckConfig.interval"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Interval (ms)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="1000"
                              max="300000"
                              {...field}
                              onChange={(e) =>
                                field.onChange(Number(e.target.value))
                              }
                            />
                          </FormControl>
                          <FormDescription>Check interval</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <div className="flex items-center justify-between pt-6 border-t">
            <Button type="button" variant="outline" onClick={handleBack}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <IconLoader2 className="w-4 h-4 mr-2 animate-spin" />}
              <IconDeviceFloppy className="w-4 h-4 mr-2" />
              {isEditing ? "Update Configuration" : "Create Configuration"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

export default NewDeploymentConfigPage;
