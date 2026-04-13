import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  CreateEnvironmentRequest,
  ENVIRONMENT_TYPES,
  ENVIRONMENT_NETWORK_TYPES,
} from "@mini-infra/types";
import { useCreateEnvironment } from "@/hooks/use-environments";
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
import { toast } from "sonner";
import { IconLoader2, IconInfoCircle } from "@tabler/icons-react";

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
  type: z.enum(ENVIRONMENT_TYPES),
  networkType: z.enum(ENVIRONMENT_NETWORK_TYPES).optional(),
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
  const createMutation = useCreateEnvironment();

  const form = useForm<CreateEnvironmentFormData>({
    resolver: zodResolver(createEnvironmentSchema),
    defaultValues: {
      name: "",
      description: "",
      type: "nonproduction",
      networkType: "local",
    },
  });

  const onSubmit = async (data: CreateEnvironmentFormData) => {
    try {
      const request: CreateEnvironmentRequest = {
        ...data,
      };

      await createMutation.mutateAsync(request);

      toast.success(`Environment "${data.name}" created successfully`);
      onOpenChange(false);
      form.reset();
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to create environment: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Create Environment</DialogTitle>
          <DialogDescription>
            Create a new environment to manage services and networks.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {/* Info Box */}
              <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-md">
                <IconInfoCircle className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm text-blue-800 font-medium">
                    Important: Environment names are permanent
                  </p>
                  <p className="text-xs text-blue-700 mt-1">
                    Once created, environment names cannot be changed to ensure consistency of Docker resources (containers, networks).
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
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}