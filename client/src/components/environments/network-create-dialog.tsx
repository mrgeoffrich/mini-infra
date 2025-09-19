import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CreateNetworkRequest } from "@mini-infra/types";
import { useCreateEnvironmentNetwork } from "@/hooks/use-environments";
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
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

const createNetworkSchema = z.object({
  name: z
    .string()
    .min(1, "Network name is required")
    .max(100, "Network name must be less than 100 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Network name must contain only letters, numbers, underscores, and hyphens",
    ),
  driver: z.string().min(1, "Driver is required"),
});

type CreateNetworkFormData = z.infer<typeof createNetworkSchema>;

interface NetworkCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  onSuccess?: () => void;
}

const NETWORK_DRIVERS = [
  { value: "bridge", label: "Bridge", description: "Default bridge network for containers" },
  { value: "host", label: "Host", description: "Use the host's network directly" },
  { value: "none", label: "None", description: "Disable networking" },
  { value: "overlay", label: "Overlay", description: "Multi-host networking for swarm services" },
  { value: "macvlan", label: "Macvlan", description: "Assign MAC addresses to containers" },
];

export function NetworkCreateDialog({
  open,
  onOpenChange,
  environmentId,
  onSuccess,
}: NetworkCreateDialogProps) {
  const createNetworkMutation = useCreateEnvironmentNetwork();

  const form = useForm<CreateNetworkFormData>({
    resolver: zodResolver(createNetworkSchema),
    defaultValues: {
      name: "",
      driver: "bridge",
    },
  });

  const onSubmit = async (data: CreateNetworkFormData) => {
    try {
      const request: CreateNetworkRequest = {
        name: data.name,
        driver: data.driver,
      };

      await createNetworkMutation.mutateAsync({
        environmentId,
        request,
      });

      toast.success(`Network "${data.name}" created successfully`);
      onOpenChange(false);
      form.reset();
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to create network: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset();
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Network</DialogTitle>
          <DialogDescription>
            Create a new Docker network for this environment.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Network Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="my-network"
                      {...field}
                      disabled={createNetworkMutation.isPending}
                    />
                  </FormControl>
                  <FormDescription>
                    Must be unique within this environment. Use letters, numbers, underscores, and hyphens only.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="driver"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Network Driver</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={createNetworkMutation.isPending}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a driver" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {NETWORK_DRIVERS.map((driver) => (
                        <SelectItem key={driver.value} value={driver.value}>
                          <div>
                            <div className="font-medium">{driver.label}</div>
                            <div className="text-xs text-muted-foreground">
                              {driver.description}
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Choose the network driver that best fits your use case.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={createNetworkMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={createNetworkMutation.isPending || !form.formState.isValid}
          >
            {createNetworkMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create Network
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}