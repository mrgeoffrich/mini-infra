import { useState } from "react";
import { useFormContext, useFieldArray } from "react-hook-form";
import {
  IconPlus,
  IconTrash,
  IconFileImport,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ApplicationConfigData } from "@/lib/application-schemas";
import { PasteEnvDialog } from "./paste-env-dialog";

export function ConfigurationCard() {
  const form = useFormContext<ApplicationConfigData>();

  const portsArray = useFieldArray({ control: form.control, name: "ports" });
  const envArray = useFieldArray({ control: form.control, name: "envVars" });
  const volumesArray = useFieldArray({
    control: form.control,
    name: "volumeMounts",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="env" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="env">Env vars</TabsTrigger>
            <TabsTrigger value="volumes">Volumes</TabsTrigger>
            <TabsTrigger value="health">Health check</TabsTrigger>
            <TabsTrigger value="ports">Ports</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          <TabsContent value="env" className="mt-4 space-y-3">
            <EnvVarsTab
              fields={envArray.fields}
              append={envArray.append}
              remove={envArray.remove}
            />
          </TabsContent>

          <TabsContent value="volumes" className="mt-4 space-y-3">
            <VolumesTab
              fields={volumesArray.fields}
              append={volumesArray.append}
              remove={volumesArray.remove}
            />
          </TabsContent>

          <TabsContent value="health" className="mt-4 space-y-4">
            <HealthCheckTab />
          </TabsContent>

          <TabsContent value="ports" className="mt-4 space-y-3">
            <PortsTab
              fields={portsArray.fields}
              append={portsArray.append}
              remove={portsArray.remove}
            />
          </TabsContent>

          <TabsContent value="advanced" className="mt-4 space-y-4">
            <AdvancedTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

type PortsArray = ReturnType<
  typeof useFieldArray<ApplicationConfigData, "ports">
>;
function PortsTab({
  fields,
  append,
  remove,
}: Pick<PortsArray, "fields" | "append" | "remove">) {
  const form = useFormContext<ApplicationConfigData>();

  return (
    <>
      <p className="text-sm text-muted-foreground">
        By default, no ports are exposed on the host. Internal container ports
        are still reachable from other services in the same environment
        (including HAProxy). Only add a mapping if you need direct host access.
      </p>
      {fields.map((field, index) => (
        <div key={field.id} className="flex items-end gap-2">
          <FormField
            control={form.control}
            name={`ports.${index}.hostPort`}
            render={({ field }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Host port</FormLabel>}
                <FormControl>
                  <Input
                    type="number"
                    placeholder="8080"
                    value={field.value || ""}
                    onChange={(e) =>
                      field.onChange(
                        e.target.value ? Number(e.target.value) : 0,
                      )
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name={`ports.${index}.containerPort`}
            render={({ field }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Container port</FormLabel>}
                <FormControl>
                  <Input
                    type="number"
                    placeholder="80"
                    value={field.value || ""}
                    onChange={(e) =>
                      field.onChange(
                        e.target.value ? Number(e.target.value) : 0,
                      )
                    }
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
                {index === 0 && <FormLabel>Protocol</FormLabel>}
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="udp">UDP</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(index)}
          >
            <IconTrash className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          append({ hostPort: 0, containerPort: 0, protocol: "tcp" })
        }
      >
        <IconPlus className="mr-1 h-4 w-4" />
        Add port
      </Button>
    </>
  );
}

type EnvArray = ReturnType<
  typeof useFieldArray<ApplicationConfigData, "envVars">
>;
function EnvVarsTab({
  fields,
  append,
  remove,
}: Pick<EnvArray, "fields" | "append" | "remove">) {
  const form = useFormContext<ApplicationConfigData>();
  const [pasteOpen, setPasteOpen] = useState(false);

  const handlePaste = (entries: { key: string; value: string }[]) => {
    const current = form.getValues("envVars");
    const byKey = new Map(current.map((e) => [e.key, e.value]));
    for (const entry of entries) {
      byKey.set(entry.key, entry.value);
    }
    const merged = Array.from(byKey, ([key, value]) => ({ key, value }));
    form.setValue("envVars", merged, { shouldDirty: true });
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {fields.length === 0
            ? "No environment variables configured."
            : `${fields.length} variable${fields.length === 1 ? "" : "s"}.`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPasteOpen(true)}
        >
          <IconFileImport className="mr-1 h-4 w-4" />
          Paste .env
        </Button>
      </div>

      {fields.map((field, index) => (
        <div key={field.id} className="flex items-end gap-2">
          <FormField
            control={form.control}
            name={`envVars.${index}.key`}
            render={({ field }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Key</FormLabel>}
                <FormControl>
                  <Input placeholder="ENV_VAR" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name={`envVars.${index}.value`}
            render={({ field }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Value</FormLabel>}
                <FormControl>
                  <Input placeholder="value" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(index)}
          >
            <IconTrash className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ key: "", value: "" })}
      >
        <IconPlus className="mr-1 h-4 w-4" />
        Add variable
      </Button>

      <PasteEnvDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        onApply={handlePaste}
      />
    </>
  );
}

type VolumesArray = ReturnType<
  typeof useFieldArray<ApplicationConfigData, "volumeMounts">
>;
function VolumesTab({
  fields,
  append,
  remove,
}: Pick<VolumesArray, "fields" | "append" | "remove">) {
  const form = useFormContext<ApplicationConfigData>();

  return (
    <>
      {fields.length === 0 && (
        <p className="text-sm text-muted-foreground">No volumes mounted.</p>
      )}
      {fields.map((field, index) => (
        <div key={field.id} className="flex items-end gap-2">
          <FormField
            control={form.control}
            name={`volumeMounts.${index}.name`}
            render={({ field }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Volume name</FormLabel>}
                <FormControl>
                  <Input placeholder="data-volume" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name={`volumeMounts.${index}.mountPath`}
            render={({ field }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Mount path</FormLabel>}
                <FormControl>
                  <Input placeholder="/data" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(index)}
          >
            <IconTrash className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ name: "", mountPath: "" })}
      >
        <IconPlus className="mr-1 h-4 w-4" />
        Add volume
      </Button>
    </>
  );
}

function HealthCheckTab() {
  const form = useFormContext<ApplicationConfigData>();
  const enabled = form.watch("enableHealthCheck");

  return (
    <>
      <FormField
        control={form.control}
        name="enableHealthCheck"
        render={({ field }) => (
          <FormItem className="flex items-center gap-3">
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
            <FormLabel className="!mt-0">Enable health check</FormLabel>
          </FormItem>
        )}
      />

      {enabled && (
        <>
          <FormField
            control={form.control}
            name="healthCheck.test"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Command</FormLabel>
                <FormControl>
                  <Input
                    placeholder="curl -f http://localhost/ || exit 1"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Shell command that exits 0 when healthy.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="healthCheck.interval"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Interval (seconds)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={field.value || ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value ? Number(e.target.value) : 0,
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="healthCheck.timeout"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Timeout (seconds)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={field.value || ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value ? Number(e.target.value) : 0,
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="healthCheck.retries"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Retries</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={field.value || ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value ? Number(e.target.value) : 0,
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="healthCheck.startPeriod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start period (seconds)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value ? Number(e.target.value) : 0,
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </>
      )}
    </>
  );
}

function AdvancedTab() {
  const form = useFormContext<ApplicationConfigData>();

  return (
    <FormField
      control={form.control}
      name="restartPolicy"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Restart policy</FormLabel>
          <Select onValueChange={field.onChange} value={field.value}>
            <FormControl>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="no">No</SelectItem>
              <SelectItem value="always">Always</SelectItem>
              <SelectItem value="unless-stopped">Unless stopped</SelectItem>
              <SelectItem value="on-failure">On failure</SelectItem>
            </SelectContent>
          </Select>
          <FormDescription>
            What Docker should do if the container exits.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
