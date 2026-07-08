import { useState } from "react";
import { useFormContext, useFieldArray } from "react-hook-form";
import { IconPlus, IconTrash, IconFileImport } from "@tabler/icons-react";
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
import type { ApplicationConfigData } from "@/lib/application-schemas";
import { PasteEnvDialog } from "./paste-env-dialog";

/**
 * Field-group bodies shared by the create wizard (composed inside the tabbed
 * `ConfigurationCard`) and the application edit page (composed into the
 * settings-rail layout). Each section is self-contained — it reads the form
 * from `useFormContext` and owns its own `useFieldArray` — so callers only
 * decide where to place it, not how to wire it.
 */

export function EnvVarsSection() {
  const form = useFormContext<ApplicationConfigData>();
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "envVars",
  });
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
    <div className="space-y-3">
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
    </div>
  );
}

export function VolumesSection() {
  const form = useFormContext<ApplicationConfigData>();
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "volumeMounts",
  });

  return (
    <div className="space-y-3">
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
    </div>
  );
}

export function PortsSection() {
  const form = useFormContext<ApplicationConfigData>();
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "ports",
  });

  return (
    <div className="space-y-3">
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
                      field.onChange(e.target.value ? Number(e.target.value) : 0)
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
                      field.onChange(e.target.value ? Number(e.target.value) : 0)
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
        onClick={() => append({ hostPort: 0, containerPort: 0, protocol: "tcp" })}
      >
        <IconPlus className="mr-1 h-4 w-4" />
        Add port
      </Button>
    </div>
  );
}

export function HealthCheckSection() {
  const form = useFormContext<ApplicationConfigData>();
  const enabled = form.watch("enableHealthCheck");

  return (
    <div className="space-y-4">
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
    </div>
  );
}

export function RestartPolicySection() {
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
