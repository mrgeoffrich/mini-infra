import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Environment, UpdateEnvironmentRequest } from "@mini-infra/types";
import { useUpdateEnvironment } from "@/hooks/use-environments";
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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

const updateEnvironmentSchema = z.object({
  description: z.string().optional(),
  type: z.enum(["production", "nonproduction"] as const).optional(),
  isActive: z.boolean().optional(),
});

type UpdateEnvironmentFormData = z.infer<typeof updateEnvironmentSchema>;

interface EnvironmentEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: Environment;
  onSuccess?: () => void;
}

export function EnvironmentEditDialog({
  open,
  onOpenChange,
  environment,
  onSuccess,
}: EnvironmentEditDialogProps) {
  const updateMutation = useUpdateEnvironment();

  const form = useForm<UpdateEnvironmentFormData>({
    resolver: zodResolver(updateEnvironmentSchema),
    defaultValues: {
      description: environment.description || "",
      type: environment.type,
      isActive: environment.isActive,
    },
  });

  const onSubmit = async (data: UpdateEnvironmentFormData) => {
    try {
      // Only include fields that have changed
      const changes: UpdateEnvironmentRequest = {};

      if (data.description !== environment.description) {
        changes.description = data.description;
      }
      if (data.type && data.type !== environment.type) {
        changes.type = data.type;
      }
      if (data.isActive !== environment.isActive) {
        changes.isActive = data.isActive;
      }

      // If no changes, just close the dialog
      if (Object.keys(changes).length === 0) {
        onOpenChange(false);
        return;
      }

      await updateMutation.mutateAsync({
        id: environment.id,
        request: changes,
      });

      toast.success(`Environment "${environment.name}" updated successfully`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to update environment: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  // Reset form when environment changes
  React.useEffect(() => {
    if (open) {
      form.reset({
        description: environment.description || "",
        type: environment.type,
        isActive: environment.isActive,
      });
    }
  }, [environment, open, form]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Environment</DialogTitle>
          <DialogDescription>
            Update the environment settings. Services will not be affected.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="p-4 bg-muted rounded-md">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">Environment Name:</span>
                <code className="text-xs bg-background px-2 py-1 rounded">{environment.name}</code>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Environment names cannot be changed after creation to maintain resource consistency.
              </p>
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Environment description..."
                      className="h-20"
                      {...field}
                      disabled={updateMutation.isPending}
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
                    value={field.value}
                    disabled={updateMutation.isPending}
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
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={updateMutation.isPending}
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Active Environment</FormLabel>
                    <FormDescription>
                      Whether this environment is actively used
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={updateMutation.isPending}
          >
            {updateMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Update Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

