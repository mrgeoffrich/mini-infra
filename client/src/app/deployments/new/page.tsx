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
import {
  AlertCircle,
  Loader2,
  Save,
  Container,
  Activity,
  Globe,
  RotateCcw,
  Info,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { EnvVarEditor } from "@/components/deployments/env-var-editor";
import { PortEditor } from "@/components/deployments/port-editor";
import { VolumeEditor } from "@/components/deployments/volume-editor";
import type {
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  ContainerConfig,
  HealthCheckConfig,
  TraefikConfig,
  RollbackConfig,
} from "@mini-infra/types";

// Form data type that matches our form structure
interface DeploymentFormData {
  applicationName: string;
  dockerImage: string;
  dockerTag: string;
  dockerRegistry: string;
  containerConfig: ContainerConfig;
  healthCheckConfig: HealthCheckConfig;
  traefikConfig: TraefikConfig;
  rollbackConfig: RollbackConfig;
  listeningPort?: number;
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

  const createMutation = useCreateDeploymentConfig();
  const updateMutation = useUpdateDeploymentConfig();

  const form = useForm<DeploymentFormData>({
    defaultValues: {
      applicationName: "",
      dockerImage: "",
      dockerTag: "latest",
      dockerRegistry: "",
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
        interval: 30000,
      },
      traefikConfig: {
        routerName: "",
        serviceName: "",
        rule: "",
        middlewares: undefined,
        tls: false,
      },
      rollbackConfig: {
        enabled: true,
        maxWaitTime: 300000,
        keepOldContainer: false,
      },
      listeningPort: undefined,
    },
    mode: "onChange",
  });

  // Update form when deployment config is loaded
  useEffect(() => {
    if (deploymentConfig) {
      form.reset({
        applicationName: deploymentConfig.applicationName || "",
        dockerImage: deploymentConfig.dockerImage || "",
        dockerTag: deploymentConfig.dockerImage?.split(":")[1] || "latest",
        dockerRegistry: deploymentConfig.dockerRegistry || "",
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
          expectedStatus: deploymentConfig.healthCheckConfig?.expectedStatus || [200],
          responseValidation: deploymentConfig.healthCheckConfig?.responseValidation || undefined,
          timeout: deploymentConfig.healthCheckConfig?.timeout || 10000,
          retries: deploymentConfig.healthCheckConfig?.retries || 3,
          interval: deploymentConfig.healthCheckConfig?.interval || 30000,
        },
        traefikConfig: {
          routerName: deploymentConfig.traefikConfig?.routerName || "",
          serviceName: deploymentConfig.traefikConfig?.serviceName || "",
          rule: deploymentConfig.traefikConfig?.rule || "",
          middlewares: deploymentConfig.traefikConfig?.middlewares || undefined,
          tls: deploymentConfig.traefikConfig?.tls || false,
        },
        rollbackConfig: {
          enabled: deploymentConfig.rollbackConfig?.enabled ?? true,
          maxWaitTime: deploymentConfig.rollbackConfig?.maxWaitTime || 300000,
          keepOldContainer: deploymentConfig.rollbackConfig?.keepOldContainer || false,
        },
        listeningPort: deploymentConfig.listeningPort || undefined,
      });
    }
  }, [deploymentConfig, form]);

  // Auto-generate router and service names from application name
  const watchedAppName = form.watch("applicationName");
  useEffect(() => {
    if (watchedAppName && !isEditing) {
      const sanitized = watchedAppName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");
      form.setValue("traefikConfig.routerName", `${sanitized}-router`);
      form.setValue("traefikConfig.serviceName", `${sanitized}-service`);
    }
  }, [watchedAppName, form, isEditing]);

  // Auto-generate rule from application name
  const watchedRouterName = form.watch("traefikConfig.routerName");
  useEffect(() => {
    if (
      watchedRouterName &&
      !isEditing &&
      !form.getValues("traefikConfig.rule")
    ) {
      const appName = watchedRouterName.replace("-router", "");
      form.setValue("traefikConfig.rule", `Host(\`${appName}.localhost\`)`);
    }
  }, [watchedRouterName, form, isEditing]);

  const onSubmit = async (data: any) => {
    setSubmitError(null);
    try {
      // Combine docker image and tag for backend
      const dockerImageWithTag =
        data.dockerTag && data.dockerTag !== "latest"
          ? `${data.dockerImage}:${data.dockerTag}`
          : data.dockerImage;

      if (isEditing && deploymentConfig) {
        const updateData: UpdateDeploymentConfigRequest = {
          applicationName: data.applicationName,
          dockerImage: dockerImageWithTag,
          dockerRegistry: data.dockerRegistry,
          containerConfig: data.containerConfig,
          healthCheckConfig: data.healthCheckConfig,
          traefikConfig: data.traefikConfig,
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
          dockerImage: dockerImageWithTag,
          dockerRegistry: data.dockerRegistry,
          containerConfig: data.containerConfig,
          healthCheckConfig: data.healthCheckConfig,
          traefikConfig: data.traefikConfig,
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

  const isLoading = createMutation.isPending || updateMutation.isPending || isLoadingConfig;

  if (isEditing && configError) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center p-8">
          <div className="text-center">
            <p className="text-muted-foreground">Failed to load deployment configuration</p>
            <p className="text-sm text-destructive mt-2">
              {configError instanceof Error ? configError.message : "Unknown error"}
            </p>
            <Button onClick={handleBack} className="mt-4">
              <ArrowLeft className="h-4 w-4 mr-2" />
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
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {isEditing ? "Edit Deployment Configuration" : "New Deployment Configuration"}
          </h1>
          <p className="text-muted-foreground">
            Configure deployment settings for your application including Docker,
            health checks, Traefik routing, and rollback options.
          </p>
        </div>
      </div>

      {submitError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="docker" className="flex items-center gap-2">
                <Container className="w-4 h-4" />
                Docker
              </TabsTrigger>
              <TabsTrigger value="health" className="flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Health Check
              </TabsTrigger>
              <TabsTrigger value="traefik" className="flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Traefik
              </TabsTrigger>
              <TabsTrigger value="rollback" className="flex items-center gap-2">
                <RotateCcw className="w-4 h-4" />
                Rollback
              </TabsTrigger>
            </TabsList>

            <TabsContent value="docker" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Container className="w-5 h-5 text-blue-500" />
                    Docker Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure the Docker image and container settings
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="applicationName"
                      render={({ field }) => (
                        <FormItem>
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
                          <FormDescription>
                            Unique name for your application (lowercase,
                            alphanumeric, hyphens only)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

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

                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2">
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
                        <FormLabel>Listening Port (Optional)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="1"
                            max="65535"
                            placeholder="8080"
                            {...field}
                            onChange={(e) => {
                              const value = e.target.value;
                              field.onChange(value ? Number(value) : undefined);
                            }}
                          />
                        </FormControl>
                        <FormDescription>
                          Specific port your application listens on for health checks. If not specified, the system will use port discovery from your port configuration.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <PortEditor form={form} />
                <VolumeEditor form={form} />
                <EnvVarEditor form={form} />
              </div>
            </TabsContent>

            <TabsContent value="health" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-green-500" />
                    Health Check Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure health checks to ensure your application is
                    ready before switching traffic
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

            <TabsContent value="traefik" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-purple-500" />
                    Traefik Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure Traefik routing and load balancing
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="traefikConfig.routerName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Router Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="my-app-router"
                              {...field}
                              onChange={(e) => {
                                const value = e.target.value
                                  .toLowerCase()
                                  .replace(/[^a-z0-9-]/g, "-");
                                field.onChange(value);
                              }}
                            />
                          </FormControl>
                          <FormDescription>
                            Unique Traefik router name
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="traefikConfig.serviceName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Service Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="my-app-service"
                              {...field}
                              onChange={(e) => {
                                const value = e.target.value
                                  .toLowerCase()
                                  .replace(/[^a-z0-9-]/g, "-");
                                field.onChange(value);
                              }}
                            />
                          </FormControl>
                          <FormDescription>
                            Unique Traefik service name
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="traefikConfig.rule"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Routing Rule</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Host(`my-app.localhost`)"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Traefik routing rule (e.g., Host(`domain.com`),
                          PathPrefix(`/api`))
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="traefikConfig.tls"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">Enable TLS</FormLabel>
                          <FormDescription>
                            Enable TLS/SSL for this service
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
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="rollback" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <RotateCcw className="w-5 h-5 text-red-500" />
                    Rollback Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure automatic rollback behavior in case of deployment
                    failures
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="rollbackConfig.enabled"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">
                            Enable Automatic Rollback
                          </FormLabel>
                          <FormDescription>
                            Automatically rollback to the previous version on
                            deployment failure
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

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="rollbackConfig.maxWaitTime"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Max Wait Time (ms)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="30000"
                              max="3600000"
                              {...field}
                              onChange={(e) =>
                                field.onChange(Number(e.target.value))
                              }
                            />
                          </FormControl>
                          <FormDescription>
                            Maximum time to wait before triggering rollback
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="rollbackConfig.keepOldContainer"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">
                              Keep Old Container
                            </FormLabel>
                            <FormDescription>
                              Keep the old container running after successful
                              deployment
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
                  </div>

                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>
                      Rollback settings help ensure service availability by
                      automatically reverting to the previous working version if
                      health checks fail or the deployment takes too long.
                    </AlertDescription>
                  </Alert>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <div className="flex items-center justify-between pt-6 border-t">
            <Button type="button" variant="outline" onClick={handleBack}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              <Save className="w-4 h-4 mr-2" />
              {isEditing ? "Update Configuration" : "Create Configuration"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

export default NewDeploymentConfigPage;