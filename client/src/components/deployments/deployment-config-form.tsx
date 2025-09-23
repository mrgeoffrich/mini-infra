import { useState } from "react";
import React from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCreateDeploymentConfig,
  useUpdateDeploymentConfig,
} from "@/hooks/use-deployment-configs";
import {
  AlertCircle,
  Loader2,
  Save,
  Container,
  Activity,
  RotateCcw,
  Info,
  Globe,
} from "lucide-react";
import { toast } from "sonner";
import { EnvVarEditor } from "./env-var-editor";
import { PortEditor } from "./port-editor";
import { VolumeEditor } from "./volume-editor";
import { HostnameFormField } from "./hostname-input";
import type {
  DeploymentConfigurationInfo,
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
} from "@mini-infra/types";

interface DeploymentConfigFormProps {
  deploymentConfig?: DeploymentConfigurationInfo | null;
  isOpen: boolean;
  onClose: () => void;
}

export function DeploymentConfigForm({
  deploymentConfig,
  isOpen,
  onClose,
}: DeploymentConfigFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("docker");
  const isEditing = !!deploymentConfig;

  const createMutation = useCreateDeploymentConfig();
  const updateMutation = useUpdateDeploymentConfig();

  const form = useForm({
    // resolver: zodResolver(formSchema),
    defaultValues: {
      applicationName: deploymentConfig?.applicationName || "",
      dockerImage: deploymentConfig?.dockerImage || "",
      dockerTag: deploymentConfig?.dockerImage?.split(":")[1] || "latest",
      dockerRegistry: deploymentConfig?.dockerRegistry || undefined,
      hostname: deploymentConfig?.hostname || "",
      containerConfig: {
        ports: deploymentConfig?.containerConfig?.ports || [],
        volumes: deploymentConfig?.containerConfig?.volumes || [],
        environment: deploymentConfig?.containerConfig?.environment || [],
        labels: deploymentConfig?.containerConfig?.labels || {},
        networks: deploymentConfig?.containerConfig?.networks || [],
      },
      healthCheckConfig: {
        endpoint: deploymentConfig?.healthCheckConfig?.endpoint || "/health",
        method: deploymentConfig?.healthCheckConfig?.method || "GET",
        expectedStatus: deploymentConfig?.healthCheckConfig?.expectedStatus || [
          200,
        ],
        responseValidation:
          deploymentConfig?.healthCheckConfig?.responseValidation || undefined,
        timeout: deploymentConfig?.healthCheckConfig?.timeout || 10000,
        retries: deploymentConfig?.healthCheckConfig?.retries || 3,
        interval: deploymentConfig?.healthCheckConfig?.interval || 30000,
      },
      rollbackConfig: {
        enabled: deploymentConfig?.rollbackConfig?.enabled ?? true,
        maxWaitTime: deploymentConfig?.rollbackConfig?.maxWaitTime || 300000,
        keepOldContainer:
          deploymentConfig?.rollbackConfig?.keepOldContainer || false,
      },
      listeningPort: deploymentConfig?.listeningPort || undefined,
    },
    mode: "onChange",
  });



  const onSubmit = async (data: {
    applicationName: string;
    dockerImage: string;
    dockerTag: string;
    dockerRegistry?: string;
    hostname?: string;
    containerConfig: any;
    healthCheckConfig: any;
    rollbackConfig: any;
    listeningPort?: number;
    environmentId?: string;
  }) => {
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
          hostname: data.hostname,
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
          dockerImage: dockerImageWithTag,
          dockerRegistry: data.dockerRegistry,
          hostname: data.hostname,
          environmentId: data.environmentId,
          containerConfig: data.containerConfig,
          healthCheckConfig: data.healthCheckConfig,
          rollbackConfig: data.rollbackConfig,
          listeningPort: data.listeningPort,
        };
        await createMutation.mutateAsync(createData);
        toast.success("Deployment configuration created successfully");
      }
      onClose();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      setSubmitError(errorMessage);
    }
  };

  // Clear error when modal opens/closes
  React.useEffect(() => {
    if (isOpen) {
      setSubmitError(null);
      setActiveTab("docker");
    }
  }, [isOpen]);

  const isLoading = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[1000px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? "Edit Deployment Configuration"
              : "Create Deployment Configuration"}
          </DialogTitle>
          <DialogDescription>
            Configure deployment settings for your application including Docker,
            health checks, and rollback options.
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <div className="flex-1 overflow-hidden">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="h-full flex flex-col"
            >
              <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex-1 flex flex-col"
              >
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger
                    value="docker"
                    className="flex items-center gap-2"
                  >
                    <Container className="w-4 h-4" />
                    Docker
                  </TabsTrigger>
                  <TabsTrigger
                    value="hostname"
                    className="flex items-center gap-2"
                  >
                    <Globe className="w-4 h-4" />
                    Hostname
                  </TabsTrigger>
                  <TabsTrigger
                    value="health"
                    className="flex items-center gap-2"
                  >
                    <Activity className="w-4 h-4" />
                    Health Check
                  </TabsTrigger>
                  <TabsTrigger
                    value="rollback"
                    className="flex items-center gap-2"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Rollback
                  </TabsTrigger>
                </TabsList>

                <div className="flex-1 overflow-y-auto mt-4">
                  <TabsContent value="docker" className="space-y-6 m-0">
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
                                <FormLabel>
                                  Docker Registry (Optional)
                                </FormLabel>
                                <FormControl>
                                  <Input placeholder="docker.io" {...field} />
                                </FormControl>
                                <FormDescription>
                                  Docker registry URL (leave empty for Docker
                                  Hub)
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

                  <TabsContent value="hostname" className="space-y-6 m-0">
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Globe className="w-5 h-5 text-blue-500" />
                          Hostname Configuration
                        </CardTitle>
                        <CardDescription>
                          Configure the public hostname for accessing your application through Cloudflare tunnel.
                          This hostname will be used to route traffic to your application.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <FormField
                          control={form.control}
                          name="hostname"
                          render={({ field }) => (
                            <HostnameFormField
                              field={field}
                              excludeConfigId={deploymentConfig?.id}
                              description="Public hostname for accessing your application (e.g., api.example.com). Leave empty if you don't need external access."
                              placeholder="api.example.com"
                            />
                          )}
                        />

                        <Alert>
                          <Info className="h-4 w-4" />
                          <AlertDescription>
                            <div className="space-y-2">
                              <p className="font-medium">About Hostnames:</p>
                              <ul className="text-sm space-y-1 list-disc list-inside">
                                <li>Hostnames must be valid domain names (e.g., api.example.com)</li>
                                <li>The system will check for conflicts with existing deployments and Cloudflare tunnels</li>
                                <li>You can leave this field empty if your application doesn't need external access</li>
                                <li>Hostnames are used for traffic routing through Cloudflare tunnels</li>
                              </ul>
                            </div>
                          </AlertDescription>
                        </Alert>
                      </CardContent>
                    </Card>
                  </TabsContent>

                  <TabsContent value="health" className="space-y-6 m-0">
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
                                <FormDescription>
                                  HTTP method to use
                                </FormDescription>
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
                                Regex pattern to validate response body
                                (optional)
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
                                <FormDescription>
                                  Request timeout
                                </FormDescription>
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
                                <FormDescription>
                                  Retry attempts
                                </FormDescription>
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
                                <FormDescription>
                                  Check interval
                                </FormDescription>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>


                  <TabsContent value="rollback" className="space-y-6 m-0">
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <RotateCcw className="w-5 h-5 text-red-500" />
                          Rollback Configuration
                        </CardTitle>
                        <CardDescription>
                          Configure automatic rollback behavior in case of
                          deployment failures
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
                                  Automatically rollback to the previous version
                                  on deployment failure
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
                                  Maximum time to wait before triggering
                                  rollback
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
                                    Keep the old container running after
                                    successful deployment
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
                            Rollback settings help ensure service availability
                            by automatically reverting to the previous working
                            version if health checks fail or the deployment
                            takes too long.
                          </AlertDescription>
                        </Alert>
                      </CardContent>
                    </Card>
                  </TabsContent>
                </div>
              </Tabs>

              <DialogFooter className="mt-4">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isLoading}>
                  {isLoading && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  <Save className="w-4 h-4 mr-2" />
                  {isEditing ? "Update Configuration" : "Create Configuration"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
