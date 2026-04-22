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
import type { CreateApplicationFormData } from "@/lib/application-schemas";

interface Props {
  networkType?: "local" | "internet";
  detectedPorts: number[];
}

function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildHostname(subdomain: string, zone: string): string {
  const sub = subdomain.trim().replace(/^\.+|\.+$/g, "");
  if (!zone) return sub;
  if (!sub) return zone;
  return `${sub}.${zone}`;
}

export function RoutingStep({ networkType, detectedPorts }: Props) {
  const form = useFormContext<CreateApplicationFormData>();
  const displayName = form.watch("displayName");
  const { data: zonesData, isLoading: zonesLoading } = useDnsZones();
  const zones = zonesData?.data?.zones ?? [];

  const { data: cfSettings } = useCloudflareSettings();
  const { data: cfConnectivity } = useCloudflareConnectivity();
  const cfConfigured = cfSettings?.data?.isConfigured ?? false;
  const cfConnected = cfConnectivity?.data?.status === "connected";
  const cfWarning = !cfConfigured
    ? "Cloudflare is not configured. DNS integration requires Cloudflare to create records and manage zones."
    : !cfConnected
      ? "Cloudflare is configured but not reachable. DNS zones shown below may be stale, and deployment may fail to provision DNS records."
      : null;

  const [subdomain, setSubdomain] = useState(() => kebabCase(displayName));
  const [zoneName, setZoneName] = useState<string>("");

  // Seed zone when zones load
  useEffect(() => {
    if (!zoneName && zones.length > 0) {
      setZoneName(zones[0].name);
    }
  }, [zones, zoneName]);

  // Keep hidden form field in sync with subdomain + zone
  useEffect(() => {
    form.setValue("routing.hostname", buildHostname(subdomain, zoneName), {
      shouldValidate: true,
    });
  }, [subdomain, zoneName, form]);

  const showPortSelect = detectedPorts.length >= 2;
  const fullHostname = buildHostname(subdomain, zoneName);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Routing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
      </CardContent>
    </Card>
  );
}
