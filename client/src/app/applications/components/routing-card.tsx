import { useEffect, useState } from "react";
import { useFormContext } from "react-hook-form";
import { Link } from "react-router-dom";
import { IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDnsZones } from "@/hooks/use-dns";
import {
  useCloudflareConnectivity,
  useCloudflareSettings,
} from "@/hooks/use-cloudflare-settings";
import {
  useAzureSettings,
  useAzureConnectivityStatus,
} from "@/hooks/use-azure-settings";
import type { ApplicationRoutingData } from "@/lib/application-schemas";

interface Props {
  networkType?: "local" | "internet";
  detectedPorts?: number[];
  showEnableToggle?: boolean;
}

function buildHostname(subdomain: string, zone: string): string {
  const sub = subdomain.trim().replace(/^\.+|\.+$/g, "");
  if (!zone) return sub;
  if (!sub) return zone;
  return `${sub}.${zone}`;
}

function decomposeHostname(
  hostname: string,
  zones: { name: string }[],
): { subdomain: string; zone: string } {
  for (const z of zones) {
    if (hostname === z.name) return { subdomain: "", zone: z.name };
    if (hostname.endsWith(`.${z.name}`)) {
      return {
        subdomain: hostname.slice(0, -(z.name.length + 1)),
        zone: z.name,
      };
    }
  }
  return { subdomain: hostname, zone: "" };
}

export function RoutingCard({
  networkType,
  detectedPorts = [],
  showEnableToggle = false,
}: Props) {
  const form = useFormContext<ApplicationRoutingData>();
  const enableRouting = form.watch("enableRouting");

  const { data: zonesData, isLoading: zonesLoading } = useDnsZones();
  const zones = zonesData?.data?.zones ?? [];

  const { data: cfSettings, isLoading: cfSettingsLoading } =
    useCloudflareSettings();
  const { data: cfConnectivity, isLoading: cfConnLoading } =
    useCloudflareConnectivity();
  const cfConfigured = cfSettings?.data?.isConfigured ?? false;
  const cfConnected = cfConnectivity?.status === "connected";
  const cfLoading = cfSettingsLoading || cfConnLoading;
  const cfNeedsTunnel = networkType === "internet";
  const cfWarning = cfLoading
    ? null
    : !cfConfigured
      ? cfNeedsTunnel
        ? "Cloudflare is not configured. Internet applications require Cloudflare to provision tunnel ingress and DNS records."
        : "Cloudflare is not configured. DNS integration requires Cloudflare to create records and manage zones."
      : !cfConnected
        ? cfNeedsTunnel
          ? "Cloudflare is configured but not reachable. DNS zones shown below may be stale, and deployment may fail to provision tunnel ingress or DNS records."
          : "Cloudflare is configured but not reachable. DNS zones shown below may be stale, and deployment may fail to provision DNS records."
        : null;

  const { data: azSettings, isLoading: azSettingsLoading } = useAzureSettings({
    enabled: networkType === "local",
  });
  const { data: azConnectivity, isLoading: azConnLoading } =
    useAzureConnectivityStatus({
      enabled: networkType === "local",
    });
  const azConfigured = azSettings?.data?.connectionConfigured ?? false;
  const azConnected = azConnectivity?.status === "connected";
  const azLoading = azSettingsLoading || azConnLoading;
  const azWarning =
    networkType === "local" && !azLoading
      ? !azConfigured
        ? "Azure Storage is not configured. Local applications use Let's Encrypt certificates, which are stored in Azure Blob Storage. Without it, TLS provisioning will fail on deploy."
        : !azConnected
          ? "Azure Storage is configured but not reachable. TLS certificate provisioning may fail on deploy."
          : null
      : null;

  const existingHostname = form.getValues("routing.hostname") ?? "";
  const [initialised, setInitialised] = useState(false);
  // Use the raw existing hostname as the initial subdomain value (no kebabCase transform).
  // The useEffect below will decompose it into subdomain + zone once zones load.
  const [subdomain, setSubdomain] = useState(existingHostname);
  const [zoneName, setZoneName] = useState<string>("");

  // Once zones load, decompose existing hostname or seed zone for new entries
  useEffect(() => {
    if (zonesLoading || initialised) return;
    setInitialised(true);

    const existing = form.getValues("routing.hostname") ?? "";
    if (existing && zones.length > 0) {
      const { subdomain: sub, zone } = decomposeHostname(existing, zones);
      setSubdomain(sub);
      // Only assign a zone when we found a real match; otherwise leave zone
      // empty so buildHostname returns the full hostname unchanged.
      if (zone) setZoneName(zone);
    } else if (!existing && zones.length > 0) {
      // New entry: seed with first available zone
      setZoneName(zones[0].name);
    }
  }, [zonesLoading, zones, form, initialised]);

  // Keep hidden form field in sync
  useEffect(() => {
    form.setValue("routing.hostname", buildHostname(subdomain, zoneName), {
      shouldValidate: true,
    });
  }, [subdomain, zoneName, form]);

  const showPortSelect = detectedPorts.length >= 2;
  const fullHostname = buildHostname(subdomain, zoneName);

  const showRoutingFields = !showEnableToggle || enableRouting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Routing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {showEnableToggle && (
          <FormField
            control={form.control}
            name="enableRouting"
            render={({ field }) => (
              <FormItem className="flex items-center gap-3">
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel className="!mt-0">Enable routing</FormLabel>
              </FormItem>
            )}
          />
        )}

        {showRoutingFields && (
          <>
            {cfWarning && (
              <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">Cloudflare connection issue</p>
                  <p className="mt-1 opacity-90">{cfWarning}</p>
                  <Link
                    to="/connectivity/cloudflare"
                    className="mt-2 inline-flex items-center gap-1 underline"
                  >
                    Configure Cloudflare
                    <IconExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            )}

            {azWarning && (
              <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">Azure Storage connection issue</p>
                  <p className="mt-1 opacity-90">{azWarning}</p>
                  <Link
                    to="/connectivity-azure"
                    className="mt-2 inline-flex items-center gap-1 underline"
                  >
                    Configure Azure Storage
                    <IconExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Hostname</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                <Input
                  placeholder="app"
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value)}
                />
                <span className="text-muted-foreground text-center">.</span>
                <Select
                  value={zoneName}
                  onValueChange={setZoneName}
                  disabled={zonesLoading || zones.length === 0}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        zonesLoading
                          ? "Loading zones..."
                          : zones.length === 0
                            ? "No DNS zones"
                            : "Select a zone"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {zones.map((zone) => (
                      <SelectItem key={zone.id} value={zone.name}>
                        {zone.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-muted-foreground text-sm">
                {fullHostname
                  ? `Full hostname: ${fullHostname}`
                  : "Enter a subdomain and choose a zone."}
              </p>
              {/* Hidden form field drives validation + submission */}
              <FormField
                control={form.control}
                name="routing.hostname"
                render={() => (
                  <FormItem>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="routing.listeningPort"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Listening port</FormLabel>
                  <FormControl>
                    {showPortSelect ? (
                      <Select
                        value={String(field.value)}
                        onValueChange={(val) => field.onChange(Number(val))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {detectedPorts.map((port) => (
                            <SelectItem key={port} value={String(port)}>
                              {port}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
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
                    )}
                  </FormControl>
                  <FormDescription>
                    The port your application listens on inside the container.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {networkType && (
              <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                {networkType === "local" &&
                  "A TLS certificate and DNS record will be automatically created for this hostname."}
                {networkType === "internet" &&
                  "A Cloudflare tunnel ingress will be automatically created for this hostname."}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
