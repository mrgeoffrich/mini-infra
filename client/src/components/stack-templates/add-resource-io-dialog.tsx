import { useEffect } from "react";
import { useForm, Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { StackResourceInput, StackResourceOutput } from "@mini-infra/types";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const resourceIOSchema = z.object({
  type: z.string().min(1, "Type is required"),
  purpose: z
    .string()
    .min(1, "Purpose is required")
    .regex(/^[a-zA-Z0-9_-]+$/, "Purpose must contain only letters, digits, hyphens, or underscores"),
  flag: z.boolean(),
});

type ResourceIOFormValues = z.infer<typeof resourceIOSchema>;

interface AddResourceIODialogProps {
  mode: "output" | "input";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (item: StackResourceOutput | StackResourceInput) => void;
}

export function AddResourceIODialog({
  mode,
  open,
  onOpenChange,
  onSave,
}: AddResourceIODialogProps) {
  const form = useForm<ResourceIOFormValues>({
    resolver: zodResolver(resourceIOSchema) as Resolver<ResourceIOFormValues>,
    defaultValues: { type: "", purpose: "", flag: false },
  });

  useEffect(() => {
    if (open) {
      form.reset({ type: "", purpose: "", flag: false });
    }
  }, [open, form]);

  function onSubmit(values: ResourceIOFormValues) {
    if (mode === "output") {
      onSave({ type: values.type, purpose: values.purpose, joinSelf: values.flag });
    } else {
      onSave({ type: values.type, purpose: values.purpose, optional: values.flag });
    }
    onOpenChange(false);
  }

  const flagLabel = mode === "output" ? "Join self" : "Optional";
  const title = mode === "output" ? "Add Output" : "Add Input";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. docker-network" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="purpose"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Purpose</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. applications" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flag"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormLabel className="cursor-pointer font-normal">
                    {flagLabel}
                  </FormLabel>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">{title}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
