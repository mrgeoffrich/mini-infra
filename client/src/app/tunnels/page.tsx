import { TunnelStatus } from "@/components/cloudflare/tunnel-status";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";

export function TunnelsPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
              <Settings className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Cloudflare Tunnels</h1>
              <p className="text-muted-foreground">
                Monitor and manage your Cloudflare tunnel connections
              </p>
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link to="/connectivity/cloudflare" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Configure Cloudflare
            </Link>
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        <div className="grid gap-6">
          {/* Tunnel Status Component */}
          <TunnelStatus />

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
                  <strong>Tunnel Status:</strong> Each tunnel shows its current
                  health status - healthy (green), degraded (yellow), inactive
                  (gray), or down (red).
                </div>
                <div>
                  <strong>Connections:</strong> Active connections display
                  client information, version, and connection timestamps.
                </div>
                <div>
                  <strong>Configuration:</strong> Manage your Cloudflare API
                  settings in the{" "}
                  <Link
                    to="/connectivity/cloudflare"
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
