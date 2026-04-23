import { useEffect } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
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
  FormDescription,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StackTemplateConfigFileInput } from "@mini-infra/types";

const configFileSchema = z.object({
  serviceName: z.string().min(1, "Service is required"),
  fileName: z.string().min(1, "File name is required"),
  volumeName: z.string().min(1, "Volume is required"),
  mountPath: z
    .string()
    .min(1, "Mount path is required")
    .regex(/^\//, "Must be an absolute path"),
  content: z.string(),
  permissions: z
    .string()
    .regex(/^[0-7]{3,4}$|^$/, "Must be 3 or 4 octal digits")
    .optional(),
  owner: z.string().optional(),
});

type ConfigFileFormValues = z.infer<typeof configFileSchema>;

interface ConfigFileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: StackTemplateConfigFileInput | null;
  serviceNames: string[];
  volumeNames: string[];
  onSave: (file: StackTemplateConfigFileInput) => void;
}

const EMPTY: ConfigFileFormValues = {
  serviceName: "",
  fileName: "",
  volumeName: "",
  mountPath: "",
  content: "",
  permissions: "",
  owner: "",
};

export function ConfigFileDrawer({
  open,
  onOpenChange,
  file,
  serviceNames,
  volumeNames,
  onSave,
}: ConfigFileDrawerProps) {
  const isEditing = file !== null;

  const form = useForm<ConfigFileFormValues>({
    resolver: zodResolver(configFileSchema) as Resolver<
      z.infer<typeof configFileSchema>
    >,
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (open) {
      form.reset(
        file
          ? {
              serviceName: file.serviceName,
              fileName: file.fileName,
              volumeName: file.volumeName,
              mountPath: file.mountPath,
              content: file.content,
              permissions: file.permissions ?? "",
              owner: file.owner ?? "",
            }
          : EMPTY,
      );
    }
  }, [open, file, form]);

  function onSubmit(values: ConfigFileFormValues) {
    onSave({
      serviceName: values.serviceName,
      fileName: values.fileName,
      volumeName: values.volumeName,
      mountPath: values.mountPath,
      content: values.content,
      permissions: values.permissions || undefined,
      owner: values.owner || undefined,
    });
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>
            {isEditing ? `Edit ${file?.fileName}` : "Add Config File"}
          </SheetTitle>
          <SheetDescription>
            Files are seeded into the named volume at stack init. Content supports{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{"{{params.name}}"}</code>{" "}
            references.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-1 min-h-0 flex-col"
          >
            <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="serviceName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Service</FormLabel>
                      {serviceNames.length > 0 ? (
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select service" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {serviceNames.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <FormControl>
                          <Input placeholder="service-name" {...field} />
                        </FormControl>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="volumeName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Volume</FormLabel>
                      {volumeNames.length > 0 ? (
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select volume" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {volumeNames.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <FormControl>
                          <Input placeholder="volume-name" {...field} />
                        </FormControl>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="fileName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>File Name</FormLabel>
                      <FormControl>
                        <Input placeholder="nginx.conf" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="mountPath"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mount Path</FormLabel>
                      <FormControl>
                        <Input placeholder="/etc/nginx/nginx.conf" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="permissions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Permissions (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="0644" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Octal mode. Blank inherits the container default.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="owner"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Owner (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="1000:1000 or root" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        UID:GID or username.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Content</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={16}
                        className="font-mono text-xs"
                        placeholder={"server {\n  listen {{params.port}};\n}"}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <SheetFooter className="flex-row justify-end border-t px-6 py-4 gap-2 mt-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isEditing ? "Save Changes" : "Add Config File"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
