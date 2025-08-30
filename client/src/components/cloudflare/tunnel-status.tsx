import { useState } from "react";
import {
  IconArrowsRightLeft,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
} from "@tabler/icons-react";
import { useCloudfareTunnels } from "@/hooks/use-cloudflare-settings";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface TunnelConnection {
  id: string;
  client_id: string;
  client_version: string;
  opened_at: string;
  origin_ip: string;
  is_primary: boolean;
}

interface Tunnel {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "inactive" | "down";
  created_at: string;
  connections?: TunnelConnection[];
  metadata?: Record<string, unknown>;
}

interface TunnelStatusProps {
  className?: string;
}

export function TunnelStatus({ className }: TunnelStatusProps) {
  const {
    data: tunnels,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useCloudfareTunnels();
  const [expandedTunnels, setExpandedTunnels] = useState<Set<string>>(
    new Set(),
  );

  const toggleExpanded = (tunnelId: string) => {
    setExpandedTunnels((prev) => {
      const next = new Set(prev);
      if (next.has(tunnelId)) {
        next.delete(tunnelId);
      } else {
        next.add(tunnelId);
      }
      return next;
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "healthy":
        return "bg-green-500";
      case "degraded":
        return "bg-yellow-500";
      case "inactive":
        return "bg-gray-500";
      case "down":
        return "bg-red-500";
      default:
        return "bg-gray-400";
    }
  };

  const getStatusBadgeVariant = (
    status: string,
  ): "default" | "destructive" | "secondary" | "outline" => {
    switch (status) {
      case "healthy":
        return "default";
      case "degraded":
        return "secondary";
      case "down":
        return "destructive";
      default:
        return "outline";
    }
  };

  const handleRefresh = () => {
    refetch();
  };

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconArrowsRightLeft className="h-5 w-5" />
            Cloudflare Tunnels
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconArrowsRightLeft className="h-5 w-5" />
            Cloudflare Tunnels
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>
              Failed to load tunnel information. Please check your Cloudflare
              settings.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const tunnelData = tunnels?.data?.tunnels as Tunnel[] | undefined;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <IconArrowsRightLeft className="h-5 w-5" />
            Cloudflare Tunnels
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefetching}
            className="flex items-center gap-2"
          >
            <IconRefresh
              className={cn("h-4 w-4", isRefetching && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!tunnelData || tunnelData.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No tunnels configured. Please check your Cloudflare account.
          </div>
        ) : (
          <div className="space-y-3">
            {tunnelData.map((tunnel) => {
              const isExpanded = expandedTunnels.has(tunnel.id);
              const connectionCount = tunnel.connections?.length || 0;

              return (
                <div
                  key={tunnel.id}
                  className="border rounded-lg overflow-hidden transition-all duration-200"
                >
                  <button
                    onClick={() => toggleExpanded(tunnel.id)}
                    className="w-full p-4 flex items-center justify-between hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex items-center">
                        {isExpanded ? (
                          <IconChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <IconChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            "w-2 h-2 rounded-full",
                            getStatusColor(tunnel.status),
                          )}
                        />
                        <div className="text-left">
                          <div className="font-medium">{tunnel.name}</div>
                          <div className="text-sm text-muted-foreground">
                            {connectionCount}{" "}
                            {connectionCount === 1
                              ? "connection"
                              : "connections"}
                          </div>
                        </div>
                      </div>
                    </div>
                    <Badge variant={getStatusBadgeVariant(tunnel.status)}>
                      {tunnel.status}
                    </Badge>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-4 border-t bg-muted/30">
                      <div className="pt-4 space-y-3">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <div className="text-muted-foreground">
                              Tunnel ID
                            </div>
                            <div className="font-mono text-xs mt-1">
                              {tunnel.id}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Created</div>
                            <div className="mt-1">
                              {format(
                                new Date(tunnel.created_at),
                                "MMM d, yyyy HH:mm",
                              )}
                            </div>
                          </div>
                        </div>

                        {tunnel.connections &&
                          tunnel.connections.length > 0 && (
                            <div>
                              <div className="text-sm font-medium mb-2">
                                Active Connections
                              </div>
                              <div className="space-y-2">
                                {tunnel.connections.map((connection) => (
                                  <div
                                    key={connection.id}
                                    className="p-2 bg-background rounded border text-xs"
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="space-y-1">
                                        <div className="font-mono">
                                          {connection.client_id}
                                        </div>
                                        <div className="text-muted-foreground">
                                          Version: {connection.client_version}
                                        </div>
                                        <div className="text-muted-foreground">
                                          Origin: {connection.origin_ip}
                                        </div>
                                      </div>
                                      <div className="text-right">
                                        {connection.is_primary && (
                                          <Badge
                                            variant="secondary"
                                            className="text-xs"
                                          >
                                            Primary
                                          </Badge>
                                        )}
                                        <div className="text-muted-foreground mt-1">
                                          {format(
                                            new Date(connection.opened_at),
                                            "HH:mm:ss",
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                        {(!tunnel.connections ||
                          tunnel.connections.length === 0) && (
                          <div className="text-sm text-muted-foreground text-center py-4">
                            No active connections
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
