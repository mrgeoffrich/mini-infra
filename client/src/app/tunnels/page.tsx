import { TunnelStatus } from "@/components/cloudflare/tunnel-status";
import { ManagedTunnelCard } from "@/components/cloudflare/managed-tunnel-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { IconSettings, IconLoader2 } from "@tabler/icons-react";
import {
  useManagedTunnels,
  useCloudflareSettings,
} from "@/hooks/use-cloudflare-settings";
import { useEnvironments } from "@/hooks/use-environments";
import type { ManagedTunnelWithStack } from "@mini-infra/types";

export function TunnelsPage() {
  const { data: managedTunnelsData, isLoading: tunnelsLoading } =
    useManagedTunnels();
  const { data: settingsData } = useCloudflareSettings();
  const { data: environmentsData, isLoading: envsLoading } = useEnvironments();

  const isCloudflareConfigured =
    settingsData?.data?.isConfigured && settingsData?.data?.hasApiToken;

  // Build a map of environmentId → managed tunnel info
  const tunnelsByEnv = new Map<string, ManagedTunnelWithStack>();
  if (managedTunnelsData?.data) {
    for (const t of managedTunnelsData.data) {
      tunnelsByEnv.set(t.environmentId, t);
    }
  }

  // Get managed tunnel IDs for highlighting in the tunnel list
  const managedTunnelIds = new Set(
    managedTunnelsData?.data?.map((t) => t.tunnelId) ?? [],
  );

  const environments = environmentsData?.environments ?? [];
  const isLoading = tunnelsLoading || envsLoading;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
              <IconSettings className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Cloudflare Tunnels</h1>
              <p className="text-muted-foreground">
                Monitor and manage your Cloudflare tunnel connections
              </p>
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link
              to="/connectivity-cloudflare"
              className="flex items-center gap-2"
            >
              <IconSettings className="h-4 w-4" />
              Configure Cloudflare
            </Link>
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        <div className="grid gap-6">
          {/* Managed Tunnels Section */}
          <Card>
            <CardHeader>
              <CardTitle>Managed Tunnels</CardTitle>
              <CardDescription>
                Create and manage Cloudflare tunnels for your environments.
                Each internet-facing environment can have its own managed
                tunnel with a cloudflared connector.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <IconLoader2 className="h-4 w-4 animate-spin" />
                  Loading environments...
                </div>
              ) : environments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No environments found. Create an environment first.
                </p>
              ) : (
                <div className="grid gap-3">
                  {environments.map((env) => (
                    <ManagedTunnelCard
                      key={env.id}
                      environment={{
                        id: env.id,
                        name: env.name,
                        networkType: env.networkType,
                      }}
                      tunnel={tunnelsByEnv.get(env.id) ?? null}
                      isCloudflareConfigured={!!isCloudflareConfigured}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Existing Tunnel Status Component (all tunnels from Cloudflare) */}
          <TunnelStatus managedTunnelIds={managedTunnelIds} />

          {/* Help Card */}
          <Card>
            <CardHeader>
              <CardTitle>Need Help?</CardTitle>
              <CardDescription>
                Learn more about managing Cloudflare tunnels
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4 text-sm">
                <div>
                  <strong>Managed Tunnels:</strong> Create a tunnel for an
                  internet-facing environment, then deploy the cloudflared
                  connector to route traffic through Cloudflare to your
                  HAProxy load balancer.
                </div>
                <div>
                  <strong>Tunnel Status:</strong> Each tunnel shows its current
                  health status - healthy (green), degraded (yellow), inactive
                  (gray), or down (red).
                </div>
                <div>
                  <strong>Configuration:</strong> Manage your Cloudflare API
                  settings in the{" "}
                  <Link
                    to="/connectivity-cloudflare"
                    className="text-blue-600 hover:underline"
                  >
                    Cloudflare settings page
                  </Link>
                  .
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
