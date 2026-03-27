import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useUpdateStackTemplate } from "@/hooks/use-stack-templates";
import { toast } from "sonner";
import { IconDeviceFloppy, IconLoader2 } from "@tabler/icons-react";
import type { StackTemplateInfo } from "@mini-infra/types";

const metadataSchema = z.object({
  displayName: z.string().min(1, "Display name is required"),
  description: z.string().optional(),
  category: z.string().optional(),
});

type MetadataFormValues = z.infer<typeof metadataSchema>;

interface TemplateMetadataCardProps {
  template: StackTemplateInfo;
  readOnly?: boolean;
}

export function TemplateMetadataCard({
  template,
  readOnly,
}: TemplateMetadataCardProps) {
  const updateMutation = useUpdateStackTemplate();

  const form = useForm<MetadataFormValues>({
    resolver: zodResolver(metadataSchema),
    defaultValues: {
      displayName: template.displayName,
      description: template.description ?? "",
      category: template.category ?? "",
    },
  });

  useEffect(() => {
    form.reset({
      displayName: template.displayName,
      description: template.description ?? "",
      category: template.category ?? "",
    });
  }, [template, form]);

  async function onSubmit(values: MetadataFormValues) {
    try {
      await updateMutation.mutateAsync({
        templateId: template.id,
        request: {
          displayName: values.displayName,
          description: values.description || undefined,
          category: values.category || undefined,
        },
      });
      toast.success("Template metadata saved");
      form.reset(values);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save template metadata");
    }
  }

  const isDirty = form.formState.isDirty;
  const isPending = updateMutation.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Template Info</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs capitalize">
            {template.source}
          </Badge>
          <Badge variant="secondary" className="text-xs capitalize">
            {template.scope}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Name</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        disabled={readOnly}
                        placeholder="My Template"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        disabled={readOnly}
                        placeholder="e.g. databases"
                      />
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
                      {...field}
                      disabled={readOnly}
                      placeholder="Describe what this template does..."
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {isDirty && !readOnly && (
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={isPending}>
                  {isPending ? (
                    <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <IconDeviceFloppy className="mr-2 h-4 w-4" />
                  )}
                  Save
                </Button>
              </div>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
