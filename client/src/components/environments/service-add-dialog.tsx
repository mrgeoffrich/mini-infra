import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Environment, AddServiceToEnvironmentRequest } from "@mini-infra/types";
import { useAddServiceToEnvironment, useAvailableServices, useServiceTypeMetadata } from "@/hooks/use-environments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { IconLoader2, IconServer, IconNetwork, IconDatabase, IconWorld } from "@tabler/icons-react";

const addServiceSchema = z.object({
  serviceName: z
    .string()
    .min(1, "Service name is required")
    .max(100, "Service name must be less than 100 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Service name must contain only letters, numbers, underscores, and hyphens",
    ),
  serviceType: z.string().min(1, "Service type is required"),
});

type AddServiceFormData = z.infer<typeof addServiceSchema>;

interface ServiceAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: Environment;
  onSuccess?: () => void;
}

export function ServiceAddDialog({
  open,
  onOpenChange,
  environment,
  onSuccess,
}: ServiceAddDialogProps) {
  const [selectedServiceType, setSelectedServiceType] = useState<string>("");

  const addServiceMutation = useAddServiceToEnvironment();

  const { data: availableServicesData, isLoading: servicesLoading } = useAvailableServices({
    enabled: open,
  });

  const { data: serviceMetadata, isLoading: metadataLoading } = useServiceTypeMetadata(
    selectedServiceType,
    environment.id,
    {
      enabled: !!selectedServiceType,
    }
  );

  const form = useForm<AddServiceFormData>({
    resolver: zodResolver(addServiceSchema),
    defaultValues: {
      serviceName: "",
      serviceType: "",
    },
  });

  const availableServices = availableServicesData?.services || [];
  const existingServiceNames = environment.services.map(s => s.serviceName);

  const onSubmit = async (data: AddServiceFormData) => {
    try {
      const request: AddServiceToEnvironmentRequest = {
        serviceName: data.serviceName,
        serviceType: data.serviceType,
        config: {}, // Default empty config
      };

      await addServiceMutation.mutateAsync({
        environmentId: environment.id,
        request,
      });

      toast.success(`Service "${data.serviceName}" added to environment successfully`);
      onOpenChange(false);
      form.reset();
      setSelectedServiceType("");
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to add service: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleServiceTypeChange = (serviceType: string) => {
    setSelectedServiceType(serviceType);
    form.setValue("serviceType", serviceType, { shouldValidate: true });

    // Auto-generate service name
    if (serviceType) {
      const baseName = serviceType.toLowerCase().replace(/[^a-z0-9]/g, "-");
      let serviceName = baseName;
      let counter = 1;

      while (existingServiceNames.includes(serviceName)) {
        serviceName = `${baseName}-${counter}`;
        counter++;
      }

      form.setValue("serviceName", serviceName, { shouldValidate: true });
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset();
      setSelectedServiceType("");
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add Service to Environment</DialogTitle>
          <DialogDescription>
            Add a new service to the "{environment.name}" environment.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="serviceType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Type</FormLabel>
                    <Select
                      onValueChange={handleServiceTypeChange}
                      value={field.value}
                      disabled={addServiceMutation.isPending || servicesLoading}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a service type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {availableServices.map((service) => (
                          <SelectItem key={service.serviceType} value={service.serviceType}>
                            <div className="flex items-center gap-2">
                              <IconServer className="h-4 w-4" />
                              <div>
                                <div className="font-medium">{service.serviceType}</div>
                                <div className="text-xs text-muted-foreground">
                                  {service.description}
                                </div>
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="serviceName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="my-service"
                        {...field}
                        disabled={addServiceMutation.isPending}
                      />
                    </FormControl>
                    <FormDescription>
                      Must be unique within this environment. Use letters, numbers, underscores, and hyphens only.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Service Metadata Display */}
              {serviceMetadata && !metadataLoading && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <IconServer className="h-5 w-5" />
                      {serviceMetadata.serviceType}
                    </CardTitle>
                    <CardDescription>{serviceMetadata.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Version and Tags */}
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">v{serviceMetadata.version || '0.0.0'}</Badge>
                      {serviceMetadata.tags?.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>

                    {/* Requirements */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                      {/* Networks */}
                      {serviceMetadata.requiredNetworks?.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1 font-medium mb-2">
                            <IconNetwork className="h-3.5 w-3.5" />
                            Networks
                          </div>
                          <ul className="space-y-1 text-muted-foreground">
                            {serviceMetadata.requiredNetworks?.map((network, i) => (
                              <li key={i}>• {network.name}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Volumes */}
                      {serviceMetadata.requiredVolumes?.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1 font-medium mb-2">
                            <IconDatabase className="h-3.5 w-3.5" />
                            Volumes
                          </div>
                          <ul className="space-y-1 text-muted-foreground">
                            {serviceMetadata.requiredVolumes?.map((volume, i) => (
                              <li key={i}>• {volume.name}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Exposed Ports */}
                      {serviceMetadata.exposedPorts?.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1 font-medium mb-2">
                            <IconWorld className="h-3.5 w-3.5" />
                            Ports
                          </div>
                          <ul className="space-y-1 text-muted-foreground">
                            {serviceMetadata.exposedPorts?.map((port, i) => (
                              <li key={i}>
                                • {port.containerPort}:{port.hostPort}
                                {port.name && ` (${port.name})`}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    {/* Dependencies */}
                    {serviceMetadata.dependencies?.length > 0 && (
                      <div>
                        <div className="font-medium mb-2">Dependencies</div>
                        <div className="flex gap-2 flex-wrap">
                          {serviceMetadata.dependencies?.map((dep) => (
                            <Badge key={dep} variant="outline" className="text-xs">
                              {dep}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {metadataLoading && selectedServiceType && (
                <div className="flex items-center justify-center py-4">
                  <IconLoader2 className="h-4 w-4 animate-spin" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    Loading service information...
                  </span>
                </div>
              )}
            </form>
          </Form>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={addServiceMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={addServiceMutation.isPending || !form.formState.isValid}
          >
            {addServiceMutation.isPending && (
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Add Service
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}