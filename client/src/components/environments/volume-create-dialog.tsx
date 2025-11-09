import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CreateVolumeRequest } from "@mini-infra/types";
import { useCreateEnvironmentVolume } from "@/hooks/use-environments";
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
import { IconLoader2 } from "@tabler/icons-react";

const createVolumeSchema = z.object({
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

type CreateVolumeFormData = z.infer<typeof createVolumeSchema>;

interface VolumeCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  onSuccess?: () => void;
}

const VOLUME_DRIVERS = [
  { value: "local", label: "Local", description: "Store data on the Docker host" },
  { value: "nfs", label: "NFS", description: "Network File System volume" },
  { value: "cifs", label: "CIFS", description: "Common Internet File System volume" },
  { value: "rexray", label: "RexRay", description: "Storage orchestration engine" },
];

export function VolumeCreateDialog({
  open,
  onOpenChange,
  environmentId,
  onSuccess,
}: VolumeCreateDialogProps) {
  const createVolumeMutation = useCreateEnvironmentVolume();

  const form = useForm<CreateVolumeFormData>({
    resolver: zodResolver(createVolumeSchema),
    defaultValues: {
      name: "",
      driver: "local",
    },
  });

  const onSubmit = async (data: CreateVolumeFormData) => {
    try {
      const request: CreateVolumeRequest = {
        name: data.name,
        driver: data.driver,
      };

      await createVolumeMutation.mutateAsync({
        environmentId,
        request,
      });

      toast.success(`Volume "${data.name}" created successfully`);
      onOpenChange(false);
      form.reset();
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to create volume: ${
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
          <DialogTitle>Create Volume</DialogTitle>
          <DialogDescription>
            Create a new Docker volume for this environment.
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
                      disabled={createVolumeMutation.isPending}
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
                    disabled={createVolumeMutation.isPending}
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
            disabled={createVolumeMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={createVolumeMutation.isPending || !form.formState.isValid}
          >
            {createVolumeMutation.isPending && (
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create Volume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}