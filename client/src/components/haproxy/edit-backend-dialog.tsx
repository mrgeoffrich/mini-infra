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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdateBackend } from "@/hooks/use-haproxy-backends";
import { HAProxyBackendInfo } from "@mini-infra/types";
import { toast } from "sonner";

const editBackendSchema = z.object({
  balanceAlgorithm: z.enum(["roundrobin", "leastconn", "source"]),
  checkTimeout: z.number().int().min(100).optional(),
  connectTimeout: z.number().int().min(100).optional(),
  serverTimeout: z.number().int().min(100).optional(),
});

type EditBackendFormValues = z.infer<typeof editBackendSchema>;

interface EditBackendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backend: HAProxyBackendInfo;
  environmentId: string;
}

export function EditBackendDialog({
  open,
  onOpenChange,
  backend,
  environmentId,
}: EditBackendDialogProps) {
  const form = useForm<EditBackendFormValues>({
    resolver: zodResolver(editBackendSchema),
    defaultValues: {
      balanceAlgorithm: (backend.balanceAlgorithm as "roundrobin" | "leastconn" | "source") || "roundrobin",
      checkTimeout: backend.checkTimeout || 5000,
      connectTimeout: backend.connectTimeout || 5000,
      serverTimeout: backend.serverTimeout || 30000,
    },
  });

  const updateBackendMutation = useUpdateBackend();

  const onSubmit = async (data: EditBackendFormValues) => {
    try {
      await updateBackendMutation.mutateAsync({
        backendName: backend.name,
        environmentId,
        request: {
          balanceAlgorithm: data.balanceAlgorithm,
          checkTimeout: data.checkTimeout,
          connectTimeout: data.connectTimeout,
          serverTimeout: data.serverTimeout,
        },
      });
      toast.success("Backend updated successfully");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        `Failed to update backend: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset({
        balanceAlgorithm: (backend.balanceAlgorithm as "roundrobin" | "leastconn" | "source") || "roundrobin",
        checkTimeout: backend.checkTimeout || 5000,
        connectTimeout: backend.connectTimeout || 5000,
        serverTimeout: backend.serverTimeout || 30000,
      });
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Backend Configuration</DialogTitle>
          <DialogDescription>
            Update configuration for backend "{backend.name}"
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="balanceAlgorithm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Balance Algorithm</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select algorithm" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="roundrobin">Round Robin</SelectItem>
                      <SelectItem value="leastconn">Least Connections</SelectItem>
                      <SelectItem value="source">Source IP</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Load balancing algorithm for distributing traffic across servers
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="checkTimeout"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Check Timeout (ms)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={100}
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 5000)}
                    />
                  </FormControl>
                  <FormDescription>
                    Timeout for health check requests
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="connectTimeout"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Connect Timeout (ms)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={100}
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 5000)}
                    />
                  </FormControl>
                  <FormDescription>
                    Timeout for establishing connections to servers
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="serverTimeout"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Server Timeout (ms)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={100}
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 30000)}
                    />
                  </FormControl>
                  <FormDescription>
                    Timeout for server response
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
                disabled={updateBackendMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateBackendMutation.isPending}>
                {updateBackendMutation.isPending ? (
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
