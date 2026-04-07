import {
  IconWorld,
  IconRefresh,
  IconAlertCircle,
  IconCloudOff,
  IconLoader2,
} from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useDnsZones, useRefreshDnsCache } from "@/hooks/use-dns";
import { useCloudflareSettings } from "@/hooks/use-cloudflare-settings";
import { DnsZoneCard } from "@/components/dns/dns-zone-card";
import { Link } from "react-router-dom";
import { toast } from "sonner";

export default function DnsPage() {
  const { data, isLoading, error, refetch } = useDnsZones();
  const cloudflare = useCloudflareSettings();
  const refreshMutation = useRefreshDnsCache();

  const isCloudflareConfigured =
    cloudflare.data?.data?.isConfigured ?? false;

  const zones = data?.data?.zones ?? [];
  const lastRefreshed = data?.data?.lastRefreshed;

  const handleRefresh = async () => {
    try {
      const result = await refreshMutation.mutateAsync();
      toast.success(
        `Refreshed ${result.data.zonesUpdated} zone${result.data.zonesUpdated !== 1 ? "s" : ""} with ${result.data.recordsUpdated} records`
      );
    } catch (err) {
      toast.error(
        `Failed to refresh: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-4 w-80" />
            </div>
          </div>
        </div>
        <div className="px-4 lg:px-6 max-w-7xl space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconWorld className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">DNS Zones</h1>
              <p className="text-muted-foreground">
                View DNS zones and records from Cloudflare
              </p>
            </div>
          </div>
        </div>
        <div className="px-4 lg:px-6 max-w-7xl">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load DNS zones: {error.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconWorld className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">DNS Zones</h1>
              <p className="text-muted-foreground">
                View DNS zones and records from Cloudflare
              </p>
              {lastRefreshed && (
                <p className="text-xs text-muted-foreground mt-1">
                  Last refreshed{" "}
                  {formatDistanceToNow(new Date(lastRefreshed), {
                    addSuffix: true,
                  })}
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
              data-tour="dns-reload-button"
            >
              <IconRefresh className="w-4 h-4 mr-1" />
              Reload
            </Button>
            {isCloudflareConfigured && (
              <Button
                size="sm"
                onClick={handleRefresh}
                disabled={refreshMutation.isPending}
                data-tour="dns-refresh-button"
              >
                {refreshMutation.isPending ? (
                  <IconLoader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <IconRefresh className="w-4 h-4 mr-1" />
                )}
                Refresh from Cloudflare
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 lg:px-6 max-w-7xl">
        {!isCloudflareConfigured ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <IconCloudOff className="h-5 w-5" />
                Cloudflare Not Connected
              </CardTitle>
              <CardDescription>
                Connect your Cloudflare account to view and cache DNS zones and
                records.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link to="/connectivity/cloudflare">
                  Configure Cloudflare
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : zones.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No DNS Data Cached</CardTitle>
              <CardDescription>
                Click "Refresh from Cloudflare" to fetch your DNS zones and
                records.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-3">
            {zones.map((zone) => (
              <DnsZoneCard key={zone.id} zone={zone} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
