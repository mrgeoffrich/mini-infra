import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { IconLoader2, IconDeviceFloppy } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useUpdateServer } from "@/hooks/use-haproxy-backends";
import { HAProxyServerInfo } from "@mini-infra/types";
import { toast } from "sonner";

const editServerSchema = z.object({
  weight: z.number().int().min(0).max(256),
  enabled: z.boolean(),
  maintenance: z.boolean(),
  checkPath: z.string().optional(),
  inter: z.number().int().min(100).optional(),
  rise: z.number().int().min(1).optional(),
  fall: z.number().int().min(1).optional(),
});

type EditServerFormValues = z.infer<typeof editServerSchema>;

interface EditServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: HAProxyServerInfo;
  backendName: string;
  environmentId: string;
}

export function EditServerDialog({
  open,
  onOpenChange,
  server,
  backendName,
  environmentId,
}: EditServerDialogProps) {
  const form = useForm<EditServerFormValues>({
    resolver: zodResolver(editServerSchema),
    defaultValues: {
      weight: server.weight,
      enabled: server.enabled,
      maintenance: server.maintenance,
      checkPath: server.checkPath || "",
      inter: server.inter || 2000,
      rise: server.rise || 3,
      fall: server.fall || 3,
    },
  });

  const updateServerMutation = useUpdateServer();

  const onSubmit = async (data: EditServerFormValues) => {
    try {
      await updateServerMutation.mutateAsync({
        backendName,
        serverName: server.name,
        environmentId,
        request: {
          weight: data.weight,
          enabled: data.enabled,
          maintenance: data.maintenance,
          checkPath: data.checkPath || undefined,
          inter: data.inter,
          rise: data.rise,
          fall: data.fall,
        },
      });
      toast.success("Server updated successfully");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        `Failed to update server: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset({
        weight: server.weight,
        enabled: server.enabled,
        maintenance: server.maintenance,
        checkPath: server.checkPath || "",
        inter: server.inter || 2000,
        rise: server.rise || 3,
        fall: server.fall || 3,
      });
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Server</DialogTitle>
          <DialogDescription>
            Update configuration for server "{server.name}" ({server.address}:{server.port})
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="weight"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Weight</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={256}
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 0)}
                    />
                  </FormControl>
                  <FormDescription>
                    Server weight for load balancing (0-256)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Enabled</FormLabel>
                    <FormDescription>
                      Whether the server accepts traffic
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

            <FormField
              control={form.control}
              name="maintenance"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Maintenance Mode</FormLabel>
                    <FormDescription>
                      Put server in maintenance (drains existing connections)
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

            <FormField
              control={form.control}
              name="checkPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Health Check Path</FormLabel>
                  <FormControl>
                    <Input placeholder="/health" {...field} />
                  </FormControl>
                  <FormDescription>
                    HTTP path for health check requests
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="inter"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Interval (ms)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={100}
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 2000)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="rise"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rise</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 3)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="fall"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fall</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 3)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Alert>
              <AlertDescription>
                Weight, Enabled, and Maintenance changes are applied to HAProxy immediately.
                Health check changes are applied on next sync.
              </AlertDescription>
            </Alert>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={updateServerMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateServerMutation.isPending}>
                {updateServerMutation.isPending ? (
                  <>
                    <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <IconDeviceFloppy className="h-4 w-4 mr-2" />
                    Save Changes
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
