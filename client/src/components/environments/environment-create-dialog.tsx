import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  CreateEnvironmentRequest,
  ServiceConfiguration,
} from "@mini-infra/types";
import { useCreateEnvironment, useAvailableServices } from "@/hooks/use-environments";
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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Plus, X, Server, Info } from "lucide-react";

const createEnvironmentSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100, "Name must be less than 100 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Name must contain only letters, numbers, underscores, and hyphens",
    ),
  description: z.string().optional(),
  type: z.enum(["production", "nonproduction"] as const),
  networkType: z.enum(["local", "internet"] as const).optional(),
  services: z
    .array(
      z.object({
        serviceName: z
          .string()
          .min(1, "Service name is required")
          .max(100, "Service name must be less than 100 characters"),
        serviceType: z.string().min(1, "Service type is required"),
        config: z.record(z.string(), z.any()).optional(),
      }),
    )
    .optional(),
});

type CreateEnvironmentFormData = z.infer<typeof createEnvironmentSchema>;

interface EnvironmentCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function EnvironmentCreateDialog({
  open,
  onOpenChange,
  onSuccess,
}: EnvironmentCreateDialogProps) {
  const [selectedServices, setSelectedServices] = useState<ServiceConfiguration[]>([]);

  const createMutation = useCreateEnvironment();
  const { data: availableServicesData, isLoading: servicesLoading } = useAvailableServices({
    enabled: open,
  });

  const form = useForm<CreateEnvironmentFormData>({
    resolver: zodResolver(createEnvironmentSchema),
    defaultValues: {
      name: "",
      description: "",
      type: "nonproduction",
      networkType: "local",
      services: [],
    },
  });

  const availableServices = availableServicesData?.services || [];

  const onSubmit = async (data: CreateEnvironmentFormData) => {
    try {
      const request: CreateEnvironmentRequest = {
        ...data,
        services: selectedServices,
      };

      await createMutation.mutateAsync(request);

      toast.success(`Environment "${data.name}" created successfully`);
      onOpenChange(false);
      form.reset();
      setSelectedServices([]);
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to create environment: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleAddService = (serviceType: string) => {
    const serviceTypeName = serviceType.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const serviceName = `${serviceTypeName}-${selectedServices.length + 1}`;

    setSelectedServices((prev) => [
      ...prev,
      {
        serviceName,
        serviceType,
        config: {},
      },
    ]);
  };

  const handleRemoveService = (index: number) => {
    setSelectedServices((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateServiceName = (index: number, name: string) => {
    setSelectedServices((prev) =>
      prev.map((service, i) => (i === index ? { ...service, serviceName: name } : service)),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Create Environment</DialogTitle>
          <DialogDescription>
            Create a new environment to manage services, networks, and volumes.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {/* Info Box */}
              <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-md">
                <Info className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm text-blue-800 font-medium">
                    Important: Environment names are permanent
                  </p>
                  <p className="text-xs text-blue-700 mt-1">
                    Once created, environment names cannot be changed to ensure consistency of Docker resources (containers, networks, volumes).
                  </p>
                </div>
              </div>

              {/* Basic Information */}
              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Environment Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="my-environment"
                          {...field}
                          disabled={createMutation.isPending}
                        />
                      </FormControl>
                      <FormDescription>
                        Use letters, numbers, underscores, and hyphens only.
                        <strong className="text-warning"> Environment names cannot be changed after creation.</strong>
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description (Optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Environment description..."
                          className="h-20"
                          {...field}
                          disabled={createMutation.isPending}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Environment Type</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={createMutation.isPending}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select environment type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="nonproduction">Non-Production</SelectItem>
                          <SelectItem value="production">Production</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Production environments have additional safety measures
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="networkType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Network Type</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={createMutation.isPending}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select network type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="local">Local</SelectItem>
                          <SelectItem value="internet">Internet</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Local networks require a host IP address. Internet networks use Cloudflare tunnels.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Services Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-medium">Services (Optional)</h3>
                    <p className="text-sm text-muted-foreground">
                      Add services to include in this environment
                    </p>
                  </div>
                </div>

                {/* Available Services */}
                {!servicesLoading && availableServices.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Available Services</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {availableServices.map((service) => (
                        <Button
                          key={service.serviceType}
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={() => handleAddService(service.serviceType)}
                          disabled={createMutation.isPending}
                          className="flex items-center gap-2 justify-start h-auto p-3"
                        >
                          <Server className="h-4 w-4" />
                          <div className="text-left">
                            <div className="font-medium">{service.serviceType}</div>
                            <div className="text-xs text-muted-foreground">
                              {service.description}
                            </div>
                          </div>
                          <Plus className="h-3 w-3 ml-auto" />
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Selected Services */}
                {selectedServices.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Selected Services</h4>
                    <div className="space-y-2">
                      {selectedServices.map((service, index) => (
                        <div
                          key={index}
                          className="flex items-center gap-2 p-3 border rounded-md"
                        >
                          <Server className="h-4 w-4 text-muted-foreground" />
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center gap-2">
                              <Input
                                placeholder="Service name"
                                value={service.serviceName}
                                onChange={(e) => handleUpdateServiceName(index, e.target.value)}
                                disabled={createMutation.isPending}
                                className="h-8"
                              />
                              <Badge variant="outline">{service.serviceType}</Badge>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() => handleRemoveService(index)}
                            disabled={createMutation.isPending}
                            className="h-8 w-8 p-0"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {servicesLoading && (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="ml-2 text-sm text-muted-foreground">
                      Loading available services...
                    </span>
                  </div>
                )}
              </div>
            </form>
          </Form>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}