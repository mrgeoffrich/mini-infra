import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { EnvironmentVolume, UpdateVolumeRequest } from "@mini-infra/types";
import { useUpdateEnvironmentVolume } from "@/hooks/use-environments";
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

const updateVolumeSchema = z.object({
  name: z
    .string()
    .min(1, "Volume name is required")
    .max(100, "Volume name must be less than 100 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Volume name must contain only letters, numbers, underscores, and hyphens",
    ),
  driver: z.string().min(1, "Driver is required"),
});

type UpdateVolumeFormData = z.infer<typeof updateVolumeSchema>;

interface VolumeEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  volume: EnvironmentVolume;
  onSuccess?: () => void;
}

const VOLUME_DRIVERS = [
  { value: "local", label: "Local", description: "Store data on the Docker host" },
  { value: "nfs", label: "NFS", description: "Network File System volume" },
  { value: "cifs", label: "CIFS", description: "Common Internet File System volume" },
  { value: "rexray", label: "RexRay", description: "Storage orchestration engine" },
];

export function VolumeEditDialog({
  open,
  onOpenChange,
  environmentId,
  volume,
  onSuccess,
}: VolumeEditDialogProps) {
  const updateVolumeMutation = useUpdateEnvironmentVolume();

  const form = useForm<UpdateVolumeFormData>({
    resolver: zodResolver(updateVolumeSchema),
    defaultValues: {
      name: volume.name,
      driver: volume.driver,
    },
  });

  // Update form when volume changes
  useEffect(() => {
    if (volume) {
      form.reset({
        name: volume.name,
        driver: volume.driver,
      });
    }
  }, [volume, form]);

  const onSubmit = async (data: UpdateVolumeFormData) => {
    try {
      const request: UpdateVolumeRequest = {
        name: data.name,
        driver: data.driver,
      };

      await updateVolumeMutation.mutateAsync({
        environmentId,
        volumeId: volume.id,
        request,
      });

      toast.success(`Volume "${data.name}" updated successfully`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to update volume: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset({
        name: volume.name,
        driver: volume.driver,
      });
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Volume</DialogTitle>
          <DialogDescription>
            Update the configuration for "{volume.name}".
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Volume Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="my-volume"
                      {...field}
                      disabled={updateVolumeMutation.isPending}
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
                  <FormLabel>Volume Driver</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={updateVolumeMutation.isPending}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a driver" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {VOLUME_DRIVERS.map((driver) => (
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
                    Choose the volume driver that best fits your storage needs.
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
            disabled={updateVolumeMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={updateVolumeMutation.isPending || !form.formState.isValid}
          >
            {updateVolumeMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Update Volume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}