import { useFieldArray, type Control, type FieldPath } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormItem, FormLabel, FormMessage, FormControl } from "@/components/ui/form";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { ServiceFormValues } from "./service-form-schema";

// Fields on the form that hold an array of { key, value } pairs.
type KeyValueArrayFieldName = "envVars" | "labels";

interface KeyValueFieldProps {
  control: Control<ServiceFormValues>;
  name: KeyValueArrayFieldName;
  label: string;
  addLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyText?: string;
  hint?: React.ReactNode;
}

/**
 * Shared editor for Record<string,string> fields (env vars, labels) rendered
 * as a key/value array in the form.
 */
export function KeyValueField({
  control,
  name,
  label,
  addLabel = "Add",
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
  emptyText = "None configured.",
  hint,
}: KeyValueFieldProps) {
  const { fields, append, remove } = useFieldArray({ control, name });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => append({ key: "", value: "" })}
        >
          <IconPlus className="mr-1 h-4 w-4" />
          {addLabel}
        </Button>
      </div>

      {hint}

      {fields.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-4 text-center">
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f, index) => (
            <div key={f.id} className="flex items-start gap-2">
              <FormField
                control={control}
                name={`${name}.${index}.key` as FieldPath<ServiceFormValues>}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="sr-only">Key</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={keyPlaceholder}
                        {...field}
                        value={field.value as string}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <span className="pt-2 text-sm text-muted-foreground">=</span>
              <FormField
                control={control}
                name={`${name}.${index}.value` as FieldPath<ServiceFormValues>}
                render={({ field }) => (
                  <FormItem className="flex-[2]">
                    <FormLabel className="sr-only">Value</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={valuePlaceholder}
                        {...field}
                        value={field.value as string}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="mt-0.5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                onClick={() => remove(index)}
              >
                <IconTrash className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
