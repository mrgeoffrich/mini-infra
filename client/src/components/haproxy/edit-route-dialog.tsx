import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  IconLoader2,
  IconDeviceFloppy,
  IconWorld,
  IconServer,
  IconShield,
} from "@tabler/icons-react";
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
import { useUpdateRoute } from "@/hooks/use-haproxy-routes";
import { SSLCertificateSelect } from "./ssl-certificate-select";
import { HAProxyRouteInfo } from "@mini-infra/types";
import { toast } from "sonner";

const editRouteSchema = z.object({
  hostname: z
    .string()
    .min(1, "Hostname is required")
    .regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid hostname format"),
  backendName: z.string().min(1, "Backend name is required"),
  useSSL: z.boolean(),
  tlsCertificateId: z.string().optional().nullable(),
  priority: z.number().int().min(0),
}).refine((data) => !data.useSSL || !!data.tlsCertificateId, {
  message: "A TLS certificate is required when SSL is enabled",
  path: ["tlsCertificateId"],
});

type EditRouteFormValues = z.infer<typeof editRouteSchema>;

interface EditRouteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route: HAProxyRouteInfo;
  frontendName: string;
  environmentId: string | null;
}

export function EditRouteDialog({
  open,
  onOpenChange,
  route,
  frontendName,
  environmentId,
}: EditRouteDialogProps) {
  const form = useForm<EditRouteFormValues>({
    resolver: zodResolver(editRouteSchema),
    defaultValues: {
      hostname: route.hostname,
      backendName: route.backendName,
      useSSL: route.useSSL,
      tlsCertificateId: route.tlsCertificateId || null,
      priority: route.priority,
    },
  });

  const updateRouteMutation = useUpdateRoute();

  const enableSsl = form.watch("useSSL");

  const onSubmit = async (data: EditRouteFormValues) => {
    try {
      await updateRouteMutation.mutateAsync({
        frontendName,
        routeId: route.id,
        request: {
          hostname: data.hostname,
          backendName: data.backendName,
          useSSL: data.useSSL,
          tlsCertificateId: data.useSSL ? (data.tlsCertificateId || null) : null,
          priority: data.priority,
        },
      });
      toast.success("Route updated successfully");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        `Failed to update route: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset({
        hostname: route.hostname,
        backendName: route.backendName,
        useSSL: route.useSSL,
        tlsCertificateId: route.tlsCertificateId || null,
        priority: route.priority,
      });
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Route</DialogTitle>
          <DialogDescription>
            Update the route configuration for "{route.hostname}"
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                    The domain name that will route to this backend
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="backendName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Backend Name</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <IconServer className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder="my-app-backend"
                        className="pl-10"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormDescription>
                    The HAProxy backend name to route traffic to
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="useSSL"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base flex items-center gap-2">
                      <IconShield className="w-4 h-4" />
                      Enable SSL/TLS
                    </FormLabel>
                    <FormDescription>
                      Route HTTPS traffic for this hostname
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

            {enableSsl && environmentId && (
              <FormField
                control={form.control}
                name="tlsCertificateId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>TLS Certificate</FormLabel>
                    <FormControl>
                      <SSLCertificateSelect
                        environmentId={environmentId}
                        value={field.value || undefined}
                        onChange={field.onChange}
                      />
                    </FormControl>
                    <FormDescription>
                      Select a TLS certificate for this route
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="priority"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Priority</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 0)}
                    />
                  </FormControl>
                  <FormDescription>
                    Route matching priority (higher values are checked first)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={updateRouteMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateRouteMutation.isPending}>
                {updateRouteMutation.isPending ? (
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
