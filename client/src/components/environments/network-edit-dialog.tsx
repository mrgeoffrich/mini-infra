import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { EnvironmentNetwork, UpdateNetworkRequest } from "@mini-infra/types";
import { useUpdateEnvironmentNetwork } from "@/hooks/use-environments";
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
import { useEffect } from "react";

const updateNetworkSchema = z.object({
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

type UpdateNetworkFormData = z.infer<typeof updateNetworkSchema>;

interface NetworkEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  network: EnvironmentNetwork;
  onSuccess?: () => void;
}

const NETWORK_DRIVERS = [
  { value: "bridge", label: "Bridge", description: "Default bridge network for containers" },
  { value: "host", label: "Host", description: "Use the host's network directly" },
  { value: "none", label: "None", description: "Disable networking" },
  { value: "overlay", label: "Overlay", description: "Multi-host networking for swarm services" },
  { value: "macvlan", label: "Macvlan", description: "Assign MAC addresses to containers" },
];

export function NetworkEditDialog({
  open,
  onOpenChange,
  environmentId,
  network,
  onSuccess,
}: NetworkEditDialogProps) {
  const updateNetworkMutation = useUpdateEnvironmentNetwork();

  const form = useForm<UpdateNetworkFormData>({
    resolver: zodResolver(updateNetworkSchema),
    defaultValues: {
      name: network.name,
      driver: network.driver,
    },
  });

  // Update form when network changes
  useEffect(() => {
    if (network) {
      form.reset({
        name: network.name,
        driver: network.driver,
      });
    }
  }, [network, form]);

  const onSubmit = async (data: UpdateNetworkFormData) => {
    try {
      const request: UpdateNetworkRequest = {
        driver: data.driver,
      };

      await updateNetworkMutation.mutateAsync({
        environmentId,
        networkId: network.id,
        request,
      });

      toast.success(`Network "${data.name}" updated successfully`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to update network: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset({
        name: network.name,
        driver: network.driver,
      });
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Network</DialogTitle>
          <DialogDescription>
            Update the configuration for "{network.name}".
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
                      disabled={updateNetworkMutation.isPending}
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
                    disabled={updateNetworkMutation.isPending}
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
            disabled={updateNetworkMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={updateNetworkMutation.isPending || !form.formState.isValid}
          >
            {updateNetworkMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Update Network
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}