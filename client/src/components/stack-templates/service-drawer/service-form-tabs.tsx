import { useFieldArray, type Control } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { ServiceFormValues } from "./service-form-schema";
import { KeyValueField } from "./key-value-field";

type Ctrl = Control<ServiceFormValues>;

const PARAM_HINT = (
  <p className="text-xs text-muted-foreground">
    Integer, or <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{"{{params.name}}"}</code>.
  </p>
);

// ---------------------------------------------------------------------------
// General tab
// ---------------------------------------------------------------------------

export function GeneralTab({
  control,
  isEditing,
  serviceType,
}: {
  control: Ctrl;
  isEditing: boolean;
  serviceType: ServiceFormValues["serviceType"];
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={control}
          name="serviceName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Service Name</FormLabel>
              <FormControl>
                <Input placeholder="my-service" disabled={isEditing} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="serviceType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Service Type</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="Stateful">Stateful</SelectItem>
                  <SelectItem value="StatelessWeb">StatelessWeb</SelectItem>
                  <SelectItem value="AdoptedWeb">AdoptedWeb</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription className="text-xs">
                {field.value === "Stateful" &&
                  "Long-lived; stop/start replacement on update."}
                {field.value === "StatelessWeb" &&
                  "Zero-downtime blue-green; requires routing."}
                {field.value === "AdoptedWeb" &&
                  "Wraps an existing container in routing."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={control}
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
          control={control}
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
          control={control}
          name="order"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Start Order</FormLabel>
              <FormControl>
                <Input type="number" min={0} {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                Lower values start first.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="dependsOn"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Depends On</FormLabel>
              <FormControl>
                <Input placeholder="service-a, service-b" {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                Comma-separated service names.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={control}
          name="restartPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Restart Policy</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="no">no</SelectItem>
                  <SelectItem value="always">always</SelectItem>
                  <SelectItem value="unless-stopped">unless-stopped</SelectItem>
                  <SelectItem value="on-failure">on-failure</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="user"
          render={({ field }) => (
            <FormItem>
              <FormLabel>User (optional)</FormLabel>
              <FormControl>
                <Input placeholder="1000:1000 or appuser" {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                UID:GID or username to run the container as.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={control}
        name="entrypoint"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Entrypoint (optional)</FormLabel>
            <FormControl>
              <Input placeholder="/usr/local/bin/docker-entrypoint.sh" {...field} />
            </FormControl>
            <FormDescription className="text-xs">
              Space-separated; overrides the image's ENTRYPOINT.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="command"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Command (optional)</FormLabel>
            <FormControl>
              <Input placeholder="sh -c 'echo hello'" {...field} />
            </FormControl>
            <FormDescription className="text-xs">
              Space-separated; overrides the image's CMD.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      {serviceType === "AdoptedWeb" && (
        <div className="rounded-md border bg-muted/30 p-3 space-y-3">
          <h4 className="text-sm font-medium">Adopted Container</h4>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={control}
              name="adoptedContainerName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Container Name</FormLabel>
                  <FormControl>
                    <Input placeholder="existing-container" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="adoptedListeningPort"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Listening Port</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} max={65535} placeholder="80" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Environment tab
// ---------------------------------------------------------------------------

export function EnvTab({ control }: { control: Ctrl }) {
  return (
    <KeyValueField
      control={control}
      name="envVars"
      label="Environment Variables"
      addLabel="Add Variable"
      keyPlaceholder="MY_VAR"
      valuePlaceholder="value or {{params.name}}"
      emptyText="No environment variables configured."
      hint={
        <p className="text-xs text-muted-foreground">
          Use <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{"{{params.name}}"}</code> to reference template parameters.
        </p>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Ports tab
// ---------------------------------------------------------------------------

export function PortsTab({ control }: { control: Ctrl }) {
  const { fields, append, remove } = useFieldArray({ control, name: "ports" });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Port Mappings</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            append({ hostPort: "0", containerPort: "80", protocol: "tcp", exposeOnHost: true })
          }
        >
          <IconPlus className="mr-1 h-4 w-4" />
          Add Port
        </Button>
      </div>
      {PARAM_HINT}

      {fields.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-4 text-center">
          <p className="text-sm text-muted-foreground">No port mappings configured.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f, index) => (
            <div
              key={f.id}
              className="flex items-start gap-2 rounded-md border p-2"
            >
              <FormField
                control={control}
                name={`ports.${index}.hostPort`}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="text-xs">Host Port</FormLabel>
                    <FormControl>
                      <Input placeholder="8080" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <span className="pt-6 text-sm text-muted-foreground">:</span>
              <FormField
                control={control}
                name={`ports.${index}.containerPort`}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="text-xs">Container Port</FormLabel>
                    <FormControl>
                      <Input placeholder="80" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`ports.${index}.protocol`}
                render={({ field }) => (
                  <FormItem className="w-24">
                    <FormLabel className="text-xs">Protocol</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
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
              <FormField
                control={control}
                name={`ports.${index}.exposeOnHost`}
                render={({ field }) => (
                  <FormItem className="w-24 pt-4">
                    <div className="flex items-center gap-2">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="text-xs !mt-0">Expose</FormLabel>
                    </div>
                  </FormItem>
                )}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="mt-5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
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

// ---------------------------------------------------------------------------
// Mounts tab
// ---------------------------------------------------------------------------

export function MountsTab({ control }: { control: Ctrl }) {
  const { fields, append, remove } = useFieldArray({ control, name: "mounts" });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Mounts</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            append({ source: "", target: "", type: "volume", readOnly: false })
          }
        >
          <IconPlus className="mr-1 h-4 w-4" />
          Add Mount
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-4 text-center">
          <p className="text-sm text-muted-foreground">No mounts configured.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f, index) => (
            <div
              key={f.id}
              className="flex items-start gap-2 rounded-md border p-2"
            >
              <FormField
                control={control}
                name={`mounts.${index}.type`}
                render={({ field }) => (
                  <FormItem className="w-28">
                    <FormLabel className="text-xs">Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="volume">volume</SelectItem>
                        <SelectItem value="bind">bind</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`mounts.${index}.source`}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="text-xs">Source</FormLabel>
                    <FormControl>
                      <Input placeholder="volume-name or /host/path" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`mounts.${index}.target`}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="text-xs">Target</FormLabel>
                    <FormControl>
                      <Input placeholder="/app/data" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`mounts.${index}.readOnly`}
                render={({ field }) => (
                  <FormItem className="w-28 pt-4">
                    <div className="flex items-center gap-2">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="text-xs !mt-0">Read only</FormLabel>
                    </div>
                  </FormItem>
                )}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="mt-5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
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

// ---------------------------------------------------------------------------
// Networks tab
// ---------------------------------------------------------------------------

export function NetworksTab({ control }: { control: Ctrl }) {
  return (
    <div className="space-y-4">
      <FormField
        control={control}
        name="joinNetworks"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Join Networks</FormLabel>
            <FormControl>
              <Input placeholder="stack-internal, monitoring" {...field} />
            </FormControl>
            <FormDescription className="text-xs">
              Comma-separated. Additional Docker networks this service should join.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="joinResourceNetworks"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Join Resource Networks</FormLabel>
            <FormControl>
              <Input placeholder="applications, tunnel" {...field} />
            </FormControl>
            <FormDescription className="text-xs">
              Comma-separated. Named infrastructure resource networks (e.g. shared
              application network, tunnel network) this service depends on.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Healthcheck tab
// ---------------------------------------------------------------------------

export function HealthcheckTab({ control }: { control: Ctrl }) {
  return (
    <div className="space-y-4">
      <FormField
        control={control}
        name="healthcheckEnabled"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-md border p-3">
            <div>
              <FormLabel>Enable Healthcheck</FormLabel>
              <FormDescription className="text-xs">
                Docker will periodically run a command to verify the container is healthy.
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="healthcheckTest"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Test Command</FormLabel>
            <FormControl>
              <Input placeholder="CMD curl -f http://localhost/health" {...field} />
            </FormControl>
            <FormDescription className="text-xs">
              Space-separated; typically starts with <code className="font-mono">CMD</code> or <code className="font-mono">CMD-SHELL</code>.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={control}
          name="healthcheckInterval"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Interval (ms)</FormLabel>
              <FormControl>
                <Input placeholder="30000" {...field} />
              </FormControl>
              {PARAM_HINT}
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="healthcheckTimeout"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Timeout (ms)</FormLabel>
              <FormControl>
                <Input placeholder="10000" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="healthcheckRetries"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Retries</FormLabel>
              <FormControl>
                <Input placeholder="3" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="healthcheckStartPeriod"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Start Period (ms)</FormLabel>
              <FormControl>
                <Input placeholder="0" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logging tab
// ---------------------------------------------------------------------------

export function LoggingTab({ control }: { control: Ctrl }) {
  return (
    <div className="space-y-4">
      <FormField
        control={control}
        name="loggingEnabled"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-md border p-3">
            <div>
              <FormLabel>Custom Log Config</FormLabel>
              <FormDescription className="text-xs">
                Override the Docker daemon's default log driver for this service.
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      <div className="grid grid-cols-3 gap-4">
        <FormField
          control={control}
          name="logType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Driver</FormLabel>
              <FormControl>
                <Input placeholder="json-file" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="logMaxSize"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max Size</FormLabel>
              <FormControl>
                <Input placeholder="10m" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="logMaxFile"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max Files</FormLabel>
              <FormControl>
                <Input placeholder="3" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Labels tab
// ---------------------------------------------------------------------------

export function LabelsTab({ control }: { control: Ctrl }) {
  return (
    <KeyValueField
      control={control}
      name="labels"
      label="Docker Labels"
      addLabel="Add Label"
      keyPlaceholder="com.example.label"
      valuePlaceholder="value"
      emptyText="No labels configured."
    />
  );
}

// ---------------------------------------------------------------------------
// Routing tab
// ---------------------------------------------------------------------------

export function RoutingTab({
  control,
  serviceType,
}: {
  control: Ctrl;
  serviceType: ServiceFormValues["serviceType"];
}) {
  if (serviceType === "Stateful") {
    return (
      <div className="rounded-md border border-dashed px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          Routing is only available for StatelessWeb and AdoptedWeb services.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={control}
          name="routingHostname"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Hostname</FormLabel>
              <FormControl>
                <Input placeholder="app.example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="routingListeningPort"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Listening Port</FormLabel>
              <FormControl>
                <Input placeholder="80" {...field} />
              </FormControl>
              {PARAM_HINT}
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={control}
        name="routingHealthCheckEndpoint"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Health Check Endpoint (optional)</FormLabel>
            <FormControl>
              <Input placeholder="/health" {...field} />
            </FormControl>
            <FormDescription className="text-xs">
              HAProxy path used to check if the backend is ready.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-3 gap-4">
        <FormField
          control={control}
          name="routingTlsCertificate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>TLS Certificate</FormLabel>
              <FormControl>
                <Input placeholder="cert-name" {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                Name of a TLS certificate resource.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="routingDnsRecord"
          render={({ field }) => (
            <FormItem>
              <FormLabel>DNS Record</FormLabel>
              <FormControl>
                <Input placeholder="dns-name" {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                Name of a DNS record resource.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="routingTunnelIngress"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tunnel Ingress</FormLabel>
              <FormControl>
                <Input placeholder="ingress-name" {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                Name of a tunnel ingress resource.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="rounded-md border bg-muted/20 p-3 space-y-3">
        <h4 className="text-sm font-medium">HAProxy Backend Options</h4>
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={control}
            name="routingBalanceAlgorithm"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Balance Algorithm</FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(v === "__default" ? "" : v)}
                  value={field.value || "__default"}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__default">Default</SelectItem>
                    <SelectItem value="roundrobin">roundrobin</SelectItem>
                    <SelectItem value="leastconn">leastconn</SelectItem>
                    <SelectItem value="source">source</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="routingCheckTimeout"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Check Timeout (ms)</FormLabel>
                <FormControl>
                  <Input placeholder="" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="routingConnectTimeout"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Connect Timeout (ms)</FormLabel>
                <FormControl>
                  <Input placeholder="" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="routingServerTimeout"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Server Timeout (ms)</FormLabel>
                <FormControl>
                  <Input placeholder="" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Init commands tab
// ---------------------------------------------------------------------------

export function InitCommandsTab({ control }: { control: Ctrl }) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "initCommands",
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Init Commands</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => append({ volumeName: "", mountPath: "", commands: "" })}
        >
          <IconPlus className="mr-1 h-4 w-4" />
          Add Init Step
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Shell commands run against a mounted volume during stack init. Useful for
        seeding config files or directories before the service starts.
      </p>

      {fields.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-4 text-center">
          <p className="text-sm text-muted-foreground">No init commands configured.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((f, index) => (
            <div key={f.id} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <FormField
                  control={control}
                  name={`initCommands.${index}.volumeName`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel className="text-xs">Volume</FormLabel>
                      <FormControl>
                        <Input placeholder="my-volume" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={control}
                  name={`initCommands.${index}.mountPath`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel className="text-xs">Mount Path</FormLabel>
                      <FormControl>
                        <Input placeholder="/data" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="mt-5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => remove(index)}
                >
                  <IconTrash className="h-4 w-4" />
                </Button>
              </div>
              <FormField
                control={control}
                name={`initCommands.${index}.commands`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Commands (one per line)</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder={"mkdir -p /data/conf\necho 'seed' > /data/conf/init"}
                        className="font-mono text-xs"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

