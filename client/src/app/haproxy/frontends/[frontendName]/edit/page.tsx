"use client";

import { useParams, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  IconArrowLeft,
  IconEdit,
  IconInfoCircle,
  IconNetwork,
  IconServer,
  IconBrandDocker,
  IconWorld,
  IconShield,
  IconX,
  IconCheck,
  IconLoader2,
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

import { SSLCertificateSelect } from "@/components/haproxy/ssl-certificate-select";
import { useFrontendByName } from "@/hooks/use-haproxy-frontend";
import { useUpdateManualFrontend } from "@/hooks/use-manual-haproxy-frontend";
import { useEnvironments } from "@/hooks/use-environments";

// ====================
// Validation Schema
// ====================

const updateManualFrontendSchema = z.object({
  hostname: z
    .string()
    .min(1, "Hostname is required")
    .regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid hostname format"),
  enableSsl: z.boolean(),
  tlsCertificateId: z.string().optional(),
});

type FormValues = z.infer<typeof updateManualFrontendSchema>;

// ====================
// Main Component
// ====================

export function EditManualFrontendPage() {
  const { frontendName } = useParams<{ frontendName: string }>();
  const navigate = useNavigate();

  // Fetch frontend details
  const {
    data: frontendResponse,
    isLoading,
    error,
  } = useFrontendByName(frontendName);

  // Fetch environments to get environment name
  const { data: environmentsResponse } = useEnvironments({
    filters: { limit: 100 },
  });

  const { mutate: updateFrontend, isPending: isUpdating } =
    useUpdateManualFrontend();

  const frontend = frontendResponse?.data;
  const environment = environmentsResponse?.environments?.find(
    (env) => env.id === frontend?.environmentId
  );

  // Initialize form
  const form = useForm<FormValues>({
    resolver: zodResolver(updateManualFrontendSchema),
    defaultValues: {
      hostname: frontend?.hostname || "",
      enableSsl: frontend?.useSSL || false,
      tlsCertificateId: frontend?.tlsCertificateId || undefined,
    },
  });

  // Update form when frontend data loads
  if (frontend && !form.formState.isDirty) {
    form.reset({
      hostname: frontend.hostname,
      enableSsl: frontend.useSSL,
      tlsCertificateId: frontend.tlsCertificateId || undefined,
    });
  }

  const handleBack = () => {
    if (frontend) {
      navigate(`/haproxy/frontends/${frontend.frontendName}`);
    } else {
      navigate("/haproxy/frontends");
    }
  };

  const handleCancel = () => {
    handleBack();
  };

  const onSubmit = (values: FormValues) => {
    if (!frontend) return;

    updateFrontend(
      {
        frontendName: frontend.frontendName,
        request: {
          hostname: values.hostname,
          enableSsl: values.enableSsl,
          tlsCertificateId: values.enableSsl ? values.tlsCertificateId : undefined,
        },
      },
      {
        onSuccess: () => {
          navigate(`/haproxy/frontends/${frontend.frontendName}`);
        },
      }
    );
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-96" />
            </div>
          </div>
        </div>
        <div className="px-4 lg:px-6 max-w-7xl">
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    );
  }

  // Error state or frontend not found
  if (error || !frontend) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button variant="ghost" onClick={handleBack}>
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>

          <div className="mt-6 p-4 border border-destructive/50 bg-destructive/10 rounded-md flex items-start gap-3">
            <IconInfoCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">
                Failed to load frontend
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Frontend not found"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Check if frontend is manual type
  if (frontend.frontendType !== "manual") {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button variant="ghost" onClick={handleBack}>
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>

          <div className="mt-6 p-4 border border-destructive/50 bg-destructive/10 rounded-md flex items-start gap-3">
            <IconInfoCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">
                Cannot edit deployment frontend
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                This is a deployment-managed frontend. Edit the deployment
                configuration instead.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const enableSsl = form.watch("enableSsl");

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <Button variant="ghost" onClick={handleBack} className="mb-4">
          <IconArrowLeft className="h-4 w-4 mr-2" />
          Back to Frontend Details
        </Button>

        <div className="flex items-start gap-3">
          <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
            <IconEdit className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Edit Frontend: {frontend.frontendName}</h1>
            <p className="text-muted-foreground mt-1">
              Update configuration for manual frontend
            </p>
          </div>
        </div>
      </div>

      {/* Info Alert */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Alert>
          <IconInfoCircle className="h-4 w-4" />
          <AlertDescription>
            Container and environment cannot be changed. To connect a different
            container, delete this frontend and create a new one.
          </AlertDescription>
        </Alert>
      </div>

      {/* Current Configuration Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <IconNetwork className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Current Configuration</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <IconServer className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Environment</p>
                </div>
                <p className="font-medium text-muted-foreground">
                  {environment ? environment.name : "Unknown"} (cannot be changed)
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <IconBrandDocker className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Container</p>
                </div>
                <p className="font-medium text-muted-foreground">
                  {frontend.containerName || "Unknown"} (cannot be changed)
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Container Port</p>
                <p className="font-medium text-muted-foreground">
                  {frontend.containerPort || "N/A"} (cannot be changed)
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Status</p>
                <p className="font-medium">
                  {frontend.status.charAt(0).toUpperCase() + frontend.status.slice(1)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Edit Form Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Editable Settings</CardTitle>
            <CardDescription>
              Modify hostname, SSL, and health check settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                {/* Hostname Input */}
                <FormField
                  control={form.control}
                  name="hostname"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <div className="flex items-center gap-2">
                          <IconWorld className="h-4 w-4" />
                          Hostname
                        </div>
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="example.domain.com"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Changing hostname will update routing rules
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* SSL Settings Section */}
                <div className="space-y-4 p-4 border rounded-md">
                  <div className="flex items-center gap-2">
                    <IconShield className="h-5 w-5 text-muted-foreground" />
                    <h3 className="font-semibold">SSL/TLS Settings</h3>
                  </div>

                  <FormField
                    control={form.control}
                    name="enableSsl"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                        <div className="space-y-0.5">
                          <FormLabel>Enable SSL/TLS</FormLabel>
                          <FormDescription>
                            Use HTTPS with SSL/TLS certificate
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

                  {enableSsl && (
                    <FormField
                      control={form.control}
                      name="tlsCertificateId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>TLS Certificate</FormLabel>
                          <FormControl>
                            <SSLCertificateSelect
                              environmentId={frontend.environmentId || ""}
                              value={field.value}
                              onChange={field.onChange}
                            />
                          </FormControl>
                          <FormDescription>
                            Select an active TLS certificate for this frontend
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>

      {/* Action Buttons */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <div className="flex items-center justify-end gap-3">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isUpdating}
          >
            <IconX className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={isUpdating || !form.formState.isDirty}
          >
            {isUpdating ? (
              <>
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <IconCheck className="h-4 w-4 mr-2" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default EditManualFrontendPage;
