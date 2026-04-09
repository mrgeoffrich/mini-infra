import { useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { StackServiceDefinition } from "@mini-infra/types";

const serviceSchema = z.object({
  serviceName: z
    .string()
    .min(1, "Service name is required")
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Must start with a letter or digit and contain only lowercase letters, digits, or hyphens",
    ),
  serviceType: z.enum(["Stateful", "StatelessWeb", "AdoptedWeb"]),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerTag: z.string().min(1, "Docker tag is required"),
  order: z.coerce.number().int().min(1, "Order must be at least 1"),
  command: z.string().optional(),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]),
  ports: z.array(
    z.object({
      containerPort: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535, "Port must be 1–65535"),
      hostPort: z.coerce
        .number()
        .int()
        .min(0)
        .max(65535, "Port must be 0–65535"),
      protocol: z.enum(["tcp", "udp"]),
    }),
  ),
  envVars: z.array(
    z.object({ key: z.string().min(1, "Key is required"), value: z.string() }),
  ),
  dependsOn: z.string(),
  routingHostname: z.string().optional(),
  routingPort: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

interface ServiceEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: StackServiceDefinition | null;
  otherServiceNames: string[];
  onSave: (service: StackServiceDefinition) => void;
}

function envToArray(
  env?: Record<string, string>,
): { key: string; value: string }[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function arrayToEnv(
  arr: { key: string; value: string }[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of arr) {
    if (key) result[key] = value;
  }
  return result;
}

export function ServiceEditDialog({
  open,
  onOpenChange,
  service,
  onSave,
}: ServiceEditDialogProps) {
  const isEditing = service !== null;

  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema) as any,
    defaultValues: {
      serviceName: "",
      serviceType: "StatelessWeb",
      dockerImage: "",
      dockerTag: "latest",
      order: 1,
      command: "",
      restartPolicy: "unless-stopped",
      ports: [],
      envVars: [],
      dependsOn: "",
      routingHostname: "",
      routingPort: undefined,
    },
  });

  const {
    fields: portFields,
    append: appendPort,
    remove: removePort,
  } = useFieldArray({ control: form.control, name: "ports" });

  const {
    fields: envFields,
    append: appendEnv,
    remove: removeEnv,
  } = useFieldArray({ control: form.control, name: "envVars" });

  const serviceType = form.watch("serviceType");

  useEffect(() => {
    if (open) {
      if (service) {
        form.reset({
          serviceName: service.serviceName,
          serviceType: service.serviceType,
          dockerImage: service.dockerImage,
          dockerTag: service.dockerTag,
          order: service.order,
          command: service.containerConfig.command?.join(" ") ?? "",
          restartPolicy:
            service.containerConfig.restartPolicy ?? "unless-stopped",
          ports: service.containerConfig.ports ?? [],
          envVars: envToArray(service.containerConfig.env),
          dependsOn: service.dependsOn.join(", "),
          routingHostname: service.routing?.hostname ?? "",
          routingPort: service.routing?.listeningPort ?? undefined,
        });
      } else {
        form.reset({
          serviceName: "",
          serviceType: "StatelessWeb",
          dockerImage: "",
          dockerTag: "latest",
          order: 1,
          command: "",
          restartPolicy: "unless-stopped",
          ports: [],
          envVars: [],
          dependsOn: "",
          routingHostname: "",
          routingPort: undefined,
        });
      }
    }
  }, [open, service, form]);

  function onSubmit(values: ServiceFormValues) {
    const dependsOn = values.dependsOn
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const containerConfig = {
      ...(values.command
        ? { command: values.command.trim().split(/\s+/) }
        : {}),
      restartPolicy: values.restartPolicy,
      ...(values.ports.length > 0 ? { ports: values.ports } : {}),
      ...(values.envVars.length > 0
        ? { env: arrayToEnv(values.envVars) }
        : {}),
    };

    const routing =
      values.serviceType === "StatelessWeb" && values.routingHostname?.trim()
        ? {
            hostname: values.routingHostname.trim(),
            listeningPort: values.routingPort ?? 80,
          }
        : undefined;

    const definition: StackServiceDefinition = {
      serviceName: values.serviceName,
      serviceType: values.serviceType,
      dockerImage: values.dockerImage,
      dockerTag: values.dockerTag,
      containerConfig,
      dependsOn,
      order: values.order,
      ...(routing ? { routing } : {}),
    };

    onSave(definition);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[700px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Edit ${service.serviceName}` : "Add Service"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <Tabs defaultValue="basic">
              <TabsList className="w-full">
                <TabsTrigger value="basic" className="flex-1">
                  Basic
                </TabsTrigger>
                <TabsTrigger value="container" className="flex-1">
                  Container
                </TabsTrigger>
                <TabsTrigger value="environment" className="flex-1">
                  Environment
                </TabsTrigger>
                <TabsTrigger value="routing" className="flex-1">
                  Routing
                </TabsTrigger>
              </TabsList>

              {/* Basic Tab */}
              <TabsContent value="basic" className="space-y-4 pt-2">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="serviceName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Service Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="my-service"
                            disabled={isEditing}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="serviceType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Service Type</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="Stateful">Stateful</SelectItem>
                            <SelectItem value="StatelessWeb">
                              StatelessWeb
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="dockerImage"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Docker Image</FormLabel>
                        <FormControl>
                          <Input placeholder="nginx" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="dockerTag"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Docker Tag</FormLabel>
                        <FormControl>
                          <Input placeholder="latest" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="order"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Order</FormLabel>
                        <FormControl>
                          <Input type="number" min={1} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="dependsOn"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Depends On</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="service-a, service-b"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </TabsContent>

              {/* Container Tab */}
              <TabsContent value="container" className="space-y-4 pt-2">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="command"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Command (optional)</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="sh -c 'echo hello'"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="restartPolicy"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Restart Policy</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="no">no</SelectItem>
                            <SelectItem value="always">always</SelectItem>
                            <SelectItem value="unless-stopped">
                              unless-stopped
                            </SelectItem>
                            <SelectItem value="on-failure">
                              on-failure
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Port Mappings</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        appendPort({
                          containerPort: 80,
                          hostPort: 0,
                          protocol: "tcp",
                        })
                      }
                    >
                      <IconPlus className="mr-1 h-4 w-4" />
                      Add Port
                    </Button>
                  </div>

                  {portFields.length === 0 ? (
                    <div className="rounded-md border border-dashed px-4 py-4 text-center">
                      <p className="text-sm text-muted-foreground">
                        No port mappings configured.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {portFields.map((portField, index) => (
                        <div
                          key={portField.id}
                          className="flex items-end gap-2"
                        >
                          <FormField
                            control={form.control}
                            name={`ports.${index}.hostPort`}
                            render={({ field }) => (
                              <FormItem className="flex-1">
                                <FormLabel className="text-xs">
                                  Host Port
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={65535}
                                    placeholder="0"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <span className="mb-2 text-sm text-muted-foreground">
                            :
                          </span>
                          <FormField
                            control={form.control}
                            name={`ports.${index}.containerPort`}
                            render={({ field }) => (
                              <FormItem className="flex-1">
                                <FormLabel className="text-xs">
                                  Container Port
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    type="number"
                                    min={1}
                                    max={65535}
                                    placeholder="80"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name={`ports.${index}.protocol`}
                            render={({ field }) => (
                              <FormItem className="w-24">
                                <FormLabel className="text-xs">
                                  Protocol
                                </FormLabel>
                                <Select
                                  onValueChange={field.onChange}
                                  value={field.value}
                                >
                                  <FormControl>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    <SelectItem value="tcp">tcp</SelectItem>
                                    <SelectItem value="udp">udp</SelectItem>
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="mb-0.5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                            onClick={() => removePort(index)}
                          >
                            <IconTrash className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Environment Tab */}
              <TabsContent value="environment" className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Environment Variables
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => appendEnv({ key: "", value: "" })}
                  >
                    <IconPlus className="mr-1 h-4 w-4" />
                    Add Variable
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Use{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    {"{{param_name}}"}
                  </code>{" "}
                  syntax to reference template parameters.
                </p>

                {envFields.length === 0 ? (
                  <div className="rounded-md border border-dashed px-4 py-4 text-center">
                    <p className="text-sm text-muted-foreground">
                      No environment variables configured.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {envFields.map((envField, index) => (
                      <div key={envField.id} className="flex items-end gap-2">
                        <FormField
                          control={form.control}
                          name={`envVars.${index}.key`}
                          render={({ field }) => (
                            <FormItem className="flex-1">
                              <FormLabel className="text-xs">Key</FormLabel>
                              <FormControl>
                                <Input placeholder="MY_VAR" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <span className="mb-2 text-sm text-muted-foreground">
                          =
                        </span>
                        <FormField
                          control={form.control}
                          name={`envVars.${index}.value`}
                          render={({ field }) => (
                            <FormItem className="flex-[2]">
                              <FormLabel className="text-xs">Value</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="value or {{param}}"
                                  {...field}
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
                          className="mb-0.5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                          onClick={() => removeEnv(index)}
                        >
                          <IconTrash className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Routing Tab */}
              <TabsContent value="routing" className="space-y-4 pt-2">
                {serviceType !== "StatelessWeb" ? (
                  <div className="rounded-md border border-dashed px-4 py-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      Routing is only available for StatelessWeb services.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="routingHostname"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Hostname</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="app.example.com"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="routingPort"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Listening Port</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min={1}
                              max={65535}
                              placeholder="80"
                              {...field}
                              value={field.value ?? ""}
                              onChange={(e) =>
                                field.onChange(
                                  e.target.value === ""
                                    ? undefined
                                    : e.target.value,
                                )
                              }
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}
              </TabsContent>
            </Tabs>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isEditing ? "Save Changes" : "Add Service"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
