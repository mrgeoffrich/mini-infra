import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  IconPlus,
  IconLoader2,
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
import { useCreateRoute } from "@/hooks/use-haproxy-routes";
import { SSLCertificateSelect } from "./ssl-certificate-select";
import { DnsZoneIndicator } from "@/components/dns/dns-zone-indicator";
import { toast } from "sonner";

const addRouteSchema = z.object({
  hostname: z
    .string()
    .min(1, "Hostname is required")
    .regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid hostname format"),
  backendName: z.string().min(1, "Backend name is required"),
  useSSL: z.boolean(),
  tlsCertificateId: z.string().optional(),
});

type AddRouteFormValues = z.infer<typeof addRouteSchema>;

interface AddRouteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frontendName: string;
  frontendId: string;
  environmentId: string | null;
}

export function AddRouteDialog({
  open,
  onOpenChange,
  frontendName,
  environmentId,
}: AddRouteDialogProps) {
  const form = useForm<AddRouteFormValues>({
    resolver: zodResolver(addRouteSchema),
    defaultValues: {
      hostname: "",
      backendName: "",
      useSSL: false,
      tlsCertificateId: "",
    },
  });

  const createRouteMutation = useCreateRoute();

  const enableSsl = form.watch("useSSL");

  const onSubmit = async (data: AddRouteFormValues) => {
    try {
      await createRouteMutation.mutateAsync({
        frontendName,
        request: {
          hostname: data.hostname,
          backendName: data.backendName,
          useSSL: data.useSSL,
          tlsCertificateId: data.useSSL ? data.tlsCertificateId : undefined,
        },
      });
      toast.success("Route added successfully");
      form.reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        `Failed to add route: ${error instanceof Error ? error.message : "Unknown error"}`
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
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Route</DialogTitle>
          <DialogDescription>
            Add a new route to the shared frontend. This will create an ACL and
            backend switching rule in HAProxy.
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
                  <DnsZoneIndicator hostname={field.value} />
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
                        value={field.value}
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

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={createRouteMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createRouteMutation.isPending}>
                {createRouteMutation.isPending ? (
                  <>
                    <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>
                    <IconPlus className="h-4 w-4 mr-2" />
                    Add Route
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
