"use client";

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  IconArrowLeft,
  IconArrowRight,
  IconPlus,
  IconServer,
  IconBrandDocker,
  IconSettings,
  IconCheck,
  IconX,
  IconCircleCheck,
  IconCircleX,
  IconAlertCircle,
  IconNetwork,
  IconShield,
  IconWorld,
  IconActivity,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

import { StepIndicator, type Step } from "@/components/haproxy/step-indicator";
import { ContainerEligibilityBadge } from "@/components/haproxy/container-eligibility-badge";
import { ConnectContainerDialog } from "@/components/haproxy/connect-container-dialog";

import { useEnvironments } from "@/hooks/use-environments";
import {
  useEligibleContainers,
  useValidateHostname,
} from "@/hooks/use-manual-haproxy-frontend";

// ====================
// Validation Schema
// ====================

const createManualFrontendSchema = z.object({
  environmentId: z.string().min(1, "Environment is required"),
  containerId: z.string().min(1, "Container is required"),
  containerName: z.string().min(1),
  containerPort: z
    .number()
    .int()
    .min(1, "Port must be at least 1")
    .max(65535, "Port must be at most 65535"),
  hostname: z
    .string()
    .min(1, "Hostname is required")
    .regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid hostname format"),
  enableSsl: z.boolean(),
  healthCheckPath: z.string(),
  needsNetworkJoin: z.boolean(),
});

type FormValues = z.infer<typeof createManualFrontendSchema>;

// ====================
// Steps Configuration
// ====================

const STEPS: Step[] = [
  { number: 1, title: "Select Environment", icon: IconServer },
  { number: 2, title: "Choose Container", icon: IconBrandDocker },
  { number: 3, title: "Configure Frontend", icon: IconSettings },
  { number: 4, title: "Review & Create", icon: IconCheck },
];

// ====================
// Main Component
// ====================

export default function CreateManualFrontendPage() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [showConnectDialog, setShowConnectDialog] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(createManualFrontendSchema),
    defaultValues: {
      environmentId: "",
      containerId: "",
      containerName: "",
      containerPort: 80,
      hostname: "",
      enableSsl: false,
      healthCheckPath: "/",
      needsNetworkJoin: false,
    },
  });

  const { data: environmentsData, isLoading: isLoadingEnvironments } =
    useEnvironments();
  const selectedEnvironmentId = form.watch("environmentId");
  const { data: containersData, isLoading: isLoadingContainers } =
    useEligibleContainers(selectedEnvironmentId || null);

  const handleNext = async (e?: React.MouseEvent) => {
    // Prevent any event propagation that might trigger the submit button
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    let fieldsToValidate: (keyof FormValues)[] = [];

    // Validate fields based on current step
    switch (currentStep) {
      case 1:
        fieldsToValidate = ["environmentId"];
        break;
      case 2:
        fieldsToValidate = ["containerId", "containerName", "containerPort"];
        break;
      case 3:
        fieldsToValidate = ["hostname", "healthCheckPath"];
        break;
    }

    const isValid = await form.trigger(fieldsToValidate);
    if (isValid) {
      // Use setTimeout to ensure the click event is fully processed before rendering step 4
      setTimeout(() => {
        setCurrentStep((prev) => Math.min(prev + 1, STEPS.length));
      }, 0);
    }
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 1));
  };

  const handleCancel = () => {
    navigate("/haproxy/frontends");
  };

  const onSubmit = async (_data: FormValues) => {
    // Open the connect container dialog instead of submitting directly
    setShowConnectDialog(true);
  };

  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    // Prevent Enter key from submitting the form except on step 4
    if (e.key === "Enter" && currentStep < 4) {
      e.preventDefault();
    }
  };

  const selectedEnvironment = environmentsData?.environments?.find(
    (e: any) => e.id === selectedEnvironmentId,
  );

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="gap-1"
          >
            <IconArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-12 h-12 rounded-md bg-orange-100 dark:bg-orange-900">
            <IconPlus className="w-6 h-6 text-orange-700 dark:text-orange-300" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Connect Container to HAProxy
            </h1>
            <p className="text-sm text-muted-foreground">
              Create a manual frontend connection to an existing Docker container
            </p>
          </div>
        </div>
      </div>

      {/* Step Indicator */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <StepIndicator steps={STEPS} currentStep={currentStep} />
      </div>

      {/* Form Content */}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} onKeyDown={handleFormKeyDown}>
          <div className="px-4 lg:px-6 max-w-7xl">
            {currentStep === 1 && (
              <EnvironmentSelectionCard
                form={form}
                environmentsData={environmentsData}
                isLoading={isLoadingEnvironments}
              />
            )}
            {currentStep === 2 && (
              <ContainerSelectionCard
                form={form}
                containersData={containersData}
                isLoading={isLoadingContainers}
                haproxyNetwork={containersData?.data?.haproxyNetwork || ""}
              />
            )}
            {currentStep === 3 && (
              <FrontendConfigurationCard
                form={form}
                environmentId={selectedEnvironmentId}
              />
            )}
            {currentStep === 4 && (
              <ValidationAndCreationCard
                form={form}
                containersData={containersData}
                environmentsData={environmentsData}
              />
            )}
          </div>

          {/* Navigation Buttons */}
          <div className="px-4 lg:px-6 max-w-7xl mt-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {currentStep > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleBack}
                  >
                    <IconArrowLeft className="w-4 h-4 mr-1" />
                    Back
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleCancel}
                >
                  <IconX className="w-4 h-4 mr-1" />
                  Cancel
                </Button>
              </div>

              {currentStep < 4 ? (
                <Button type="button" onClick={handleNext}>
                  Next
                  <IconArrowRight className="w-4 h-4 ml-1" />
                </Button>
              ) : (
                <Button type="submit" className="gap-1">
                  <IconCheck className="w-4 h-4" />
                  Create Frontend
                </Button>
              )}
            </div>
          </div>
        </form>
      </Form>

      {/* Connect Container Progress Dialog */}
      <ConnectContainerDialog
        open={showConnectDialog}
        onOpenChange={setShowConnectDialog}
        request={form.getValues()}
        environmentName={selectedEnvironment?.name || ""}
        onSuccess={() => navigate("/haproxy/frontends")}
      />
    </div>
  );
}

// ====================
// Step 1: Environment Selection
// ====================

interface EnvironmentSelectionCardProps {
  form: any;
  environmentsData: any;
  isLoading: boolean;
}

function EnvironmentSelectionCard({
  form,
  environmentsData,
  isLoading,
}: EnvironmentSelectionCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-96" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const environments = environmentsData?.environments || [];
  const selectedEnvId = form.watch("environmentId");
  const selectedEnv = environments.find((e: any) => e.id === selectedEnvId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Environment</CardTitle>
        <CardDescription>
          Choose the environment where HAProxy is running
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          control={form.control}
          name="environmentId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Environment</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an environment" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {environments.map((env: any) => (
                    <SelectItem key={env.id} value={env.id}>
                      <div className="flex items-center gap-2">
                        <IconServer className="w-4 h-4" />
                        <span>{env.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {selectedEnv && (
          <Alert>
            <IconCircleCheck className="w-4 h-4 text-green-600" />
            <AlertDescription>
              Environment <strong>{selectedEnv.name}</strong> selected
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

// ====================
// Step 2: Container Selection
// ====================

interface ContainerSelectionCardProps {
  form: any;
  containersData: any;
  isLoading: boolean;
  haproxyNetwork: string;
}

function ContainerSelectionCard({
  form,
  containersData,
  isLoading,
  haproxyNetwork,
}: ContainerSelectionCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-96" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    );
  }

  const containers = containersData?.data?.containers || [];
  const selectedContainerId = form.watch("containerId");
  const selectedContainer = containers.find(
    (c: any) => c.id === selectedContainerId,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Container</CardTitle>
        <CardDescription>
          Choose a running container to connect to HAProxy
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {haproxyNetwork && (
          <Alert>
            <IconNetwork className="w-4 h-4 text-blue-600" />
            <AlertDescription>
              HAProxy is on network: <strong>{haproxyNetwork}</strong>
            </AlertDescription>
          </Alert>
        )}

        <div className="max-h-[400px] overflow-y-auto w-full pr-4">
          <div className="space-y-3">
            {containers.map((container: any) => (
              <div
                key={container.id}
                className={`border rounded-lg p-4 cursor-pointer transition-colors ${
                  selectedContainerId === container.id
                    ? "border-blue-600 bg-blue-50 dark:bg-blue-950"
                    : "border-border hover:border-muted-foreground"
                } ${
                  !container.canConnect
                    ? "opacity-60 cursor-not-allowed"
                    : ""
                }`}
                onClick={() => {
                  if (container.canConnect) {
                    form.setValue("containerId", container.id);
                    form.setValue("containerName", container.name);
                    form.setValue("needsNetworkJoin", container.needsNetworkJoin ?? false);
                    // Auto-fill container port if available
                    if (
                      container.ports?.length > 0 &&
                      container.ports[0].containerPort
                    ) {
                      form.setValue(
                        "containerPort",
                        container.ports[0].containerPort,
                      );
                    }
                  }
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1">
                    <IconBrandDocker className="w-5 h-5 mt-0.5 text-blue-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium truncate">
                          {container.name}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {container.state}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mb-2">
                        {container.image}
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs">
                        {container.networks?.map((network: string) => (
                          <Badge key={network} variant="secondary">
                            {network}
                          </Badge>
                        ))}
                      </div>
                      {container.ports?.length > 0 && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          Ports: {container.ports.map((p: any) => p.containerPort).join(", ")}
                        </div>
                      )}
                    </div>
                  </div>
                  <ContainerEligibilityBadge
                    canConnect={container.canConnect}
                    needsNetworkJoin={container.needsNetworkJoin}
                    reason={container.reason}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {selectedContainer && (
          <FormField
            control={form.control}
            name="containerPort"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Container Port</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    placeholder="80"
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>
                  The port the container is listening on (1-65535)
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ====================
// Step 3: Frontend Configuration
// ====================

interface FrontendConfigurationCardProps {
  form: any;
  environmentId: string;
}

function FrontendConfigurationCard({
  form,
  environmentId,
}: FrontendConfigurationCardProps) {
  const hostname = form.watch("hostname");
  const enableSsl = form.watch("enableSsl");
  const { available: hostnameAvailable, conflictingFrontend } =
    useValidateHostname(hostname, environmentId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Frontend Configuration</CardTitle>
        <CardDescription>
          Configure routing and connectivity settings
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <FormField
          control={form.control}
          name="hostname"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Hostname</FormLabel>
              <FormControl>
                <div className="relative">
                  <IconWorld className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="app.example.com"
                    className="pl-10"
                    {...field}
                  />
                </div>
              </FormControl>
              <FormDescription>
                The domain name for this frontend
              </FormDescription>
              {hostname && !hostnameAvailable && (
                <Alert variant="destructive">
                  <IconAlertCircle className="w-4 h-4" />
                  <AlertDescription>
                    Hostname already in use by frontend: {conflictingFrontend}
                  </AlertDescription>
                </Alert>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="enableSsl"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <FormLabel className="text-base flex items-center gap-2">
                  <IconShield className="w-4 h-4" />
                  Enable SSL/TLS
                </FormLabel>
                <FormDescription>
                  Serve this frontend over HTTPS with a TLS certificate
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

        {enableSsl && hostname && (
          <Alert>
            <IconShield className="w-4 h-4 text-green-600" />
            <AlertDescription>
              A TLS certificate for <strong>{hostname}</strong> will be
              automatically found or issued when you create the frontend.
            </AlertDescription>
          </Alert>
        )}

        <FormField
          control={form.control}
          name="healthCheckPath"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Health Check Path</FormLabel>
              <FormControl>
                <div className="relative">
                  <IconActivity className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder="/" className="pl-10" {...field} />
                </div>
              </FormControl>
              <FormDescription>
                Endpoint HAProxy will ping for health checks
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}

// ====================
// Step 4: Validation and Creation
// ====================

interface ValidationAndCreationCardProps {
  form: any;
  containersData: any;
  environmentsData: any;
}

function ValidationAndCreationCard({
  form,
  containersData,
  environmentsData,
}: ValidationAndCreationCardProps) {
  const values = form.getValues();
  const environment = environmentsData?.environments?.find(
    (e: any) => e.id === values.environmentId,
  );
  const container = containersData?.data?.containers?.find(
    (c: any) => c.id === values.containerId,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review & Create</CardTitle>
        <CardDescription>
          Verify configuration before creating
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Configuration Preview */}
        <div className="space-y-3">
          <h3 className="font-medium text-sm">Configuration Summary</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Environment:</span>
              <p className="font-medium">{environment?.name}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Container:</span>
              <p className="font-medium">{container?.name}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Hostname:</span>
              <p className="font-medium">{values.hostname}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Port:</span>
              <p className="font-medium">{values.containerPort}</p>
            </div>
            <div>
              <span className="text-muted-foreground">SSL:</span>
              <p className="font-medium">
                {values.enableSsl ? "Enabled" : "Disabled"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Health Check:</span>
              <p className="font-medium">{values.healthCheckPath}</p>
            </div>
            {values.needsNetworkJoin && (
              <div>
                <span className="text-muted-foreground">Network Join:</span>
                <p className="font-medium text-amber-600 dark:text-amber-400">Required</p>
              </div>
            )}
          </div>
        </div>

        {/* Validation Checks */}
        <div className="space-y-3">
          <h3 className="font-medium text-sm">Validation Checks</h3>
          <div className="space-y-2">
            <ValidationCheck
              label="Container is running"
              status={container?.state === "running"}
            />
            {values.needsNetworkJoin ? (
              <div className="flex items-center gap-2">
                <IconAlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-500" />
                <span className="text-sm">Will be joined to HAProxy network</span>
              </div>
            ) : (
              <ValidationCheck
                label="Network connectivity"
                status={container?.canConnect || false}
              />
            )}
            <ValidationCheck
              label="Hostname is available"
              status={true} // Already validated in step 3
            />
            {values.enableSsl && (
              <ValidationCheck
                label="TLS certificate will be auto-resolved"
                status={true}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ====================
// Validation Check Component
// ====================

interface ValidationCheckProps {
  label: string;
  status: boolean;
}

function ValidationCheck({ label, status }: ValidationCheckProps) {
  return (
    <div className="flex items-center gap-2">
      {status ? (
        <IconCircleCheck className="w-4 h-4 text-green-600 dark:text-green-500" />
      ) : (
        <IconCircleX className="w-4 h-4 text-red-600 dark:text-red-500" />
      )}
      <span className="text-sm">{label}</span>
    </div>
  );
}
