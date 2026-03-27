import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type {
  StackParameterDefinition,
  StackParameterValue,
} from "@mini-infra/types";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
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

const parameterSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .regex(
      /^[a-z_][a-z0-9_]*$/,
      "Name must start with a letter or underscore, and contain only lowercase letters, digits, or underscores",
    ),
  type: z.enum(["string", "number", "boolean"]),
  defaultValue: z.string(),
  description: z.string().optional(),
});

type ParameterFormValues = z.infer<typeof parameterSchema>;

interface ParameterEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parameter: StackParameterDefinition | null;
  defaultValue?: StackParameterValue;
  onSave: (
    param: StackParameterDefinition,
    defaultValue?: StackParameterValue,
  ) => void;
}

export function ParameterEditDialog({
  open,
  onOpenChange,
  parameter,
  defaultValue,
  onSave,
}: ParameterEditDialogProps) {
  const isEditing = parameter !== null;

  const form = useForm<ParameterFormValues>({
    resolver: zodResolver(parameterSchema),
    defaultValues: {
      name: "",
      type: "string",
      defaultValue: "",
      description: "",
    },
  });

  useEffect(() => {
    if (open) {
      if (parameter) {
        const dv =
          defaultValue !== undefined ? defaultValue : parameter.default;
        form.reset({
          name: parameter.name,
          type: parameter.type,
          defaultValue: dv !== undefined ? String(dv) : "",
          description: parameter.description ?? "",
        });
      } else {
        form.reset({
          name: "",
          type: "string",
          defaultValue: "",
          description: "",
        });
      }
    }
  }, [open, parameter, defaultValue, form]);

  function onSubmit(values: ParameterFormValues) {
    let parsedDefault: StackParameterValue;

    if (values.type === "number") {
      parsedDefault = Number(values.defaultValue);
    } else if (values.type === "boolean") {
      parsedDefault = values.defaultValue === "true";
    } else {
      parsedDefault = values.defaultValue;
    }

    const typeDefaults: Record<string, StackParameterValue> = {
      string: "",
      number: 0,
      boolean: false,
    };

    const definition: StackParameterDefinition = {
      name: values.name,
      type: values.type,
      description: values.description || undefined,
      default: parsedDefault ?? typeDefaults[values.type],
    };

    onSave(definition, parsedDefault);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Parameter" : "Add Parameter"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="my_param"
                      disabled={isEditing}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="string">string</SelectItem>
                        <SelectItem value="number">number</SelectItem>
                        <SelectItem value="boolean">boolean</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="defaultValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default Value</FormLabel>
                    <FormControl>
                      <Input placeholder="default" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe this parameter..."
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isEditing ? "Save Changes" : "Add Parameter"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
