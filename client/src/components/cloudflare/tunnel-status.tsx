import { useState, useEffect } from "react";
import {
  IconArrowsLeftRight,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import {
  useCloudfareTunnels,
  useCloudfareTunnelConfig,
  useAddTunnelHostname,
  useRemoveTunnelHostname,
} from "@/hooks/use-cloudflare-settings";
import { cn } from "@/lib/utils";
import { format, isValid } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";

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
  managedTunnelIds?: Set<string>;
}

// Component for adding a new hostname
function AddHostnameDialog({ tunnelId }: { tunnelId: string }) {
  const [open, setOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const [service, setService] = useState("");
  const [path, setPath] = useState("");

  const addHostname = useAddTunnelHostname();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!hostname.trim() || !service.trim()) {
      toast.error("Hostname and service are required fields.");
      return;
    }

    try {
      await addHostname.mutateAsync({
        tunnelId,
        hostname: hostname.trim(),
        service: service.trim(),
        path: path.trim() || undefined,
      });

      toast.success(`Hostname ${hostname} added successfully.`);

      // Reset form and close dialog
      setHostname("");
      setService("");
      setPath("");
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add hostname",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <IconPlus className="h-4 w-4" />
          Add Hostname
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Public Hostname</DialogTitle>
          <DialogDescription>
            Add a new public hostname that will route to a backend service.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="hostname">Hostname *</Label>
            <Input
              id="hostname"
              type="text"
              placeholder="e.g., app.example.com or *.example.com"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              required
            />
            <div className="text-xs text-muted-foreground">
              Can include wildcards like *.example.com
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="service">Backend Service *</Label>
            <Input
              id="service"
              type="text"
              placeholder="e.g., http://localhost:3000 or localhost:8080"
              value={service}
              onChange={(e) => setService(e.target.value)}
              required
            />
            <div className="text-xs text-muted-foreground">
              The URL or address:port of your backend service
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="path">Path Pattern (optional)</Label>
            <Input
              id="path"
              type="text"
              placeholder="e.g., /api/* or /static/*"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              Optional path pattern for this hostname
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={addHostname.isPending}>
              {addHostname.isPending ? "Adding..." : "Add Hostname"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Helper component to display tunnel configuration with hostname management
function TunnelConfigurationSection({ tunnelId }: { tunnelId: string }) {
  const {
    data: configData,
    isLoading: configLoading,
    error: configError,
  } = useCloudfareTunnelConfig(tunnelId);

  const removeHostname = useRemoveTunnelHostname();

  if (configLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        Loading configuration...
      </div>
    );
  }

  if (configError) {
    return (
      <div className="text-sm text-muted-foreground">
        Configuration not available
      </div>
    );
  }

  const config = configData?.data;
  if (!config?.config?.ingress) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-muted-foreground">
          No configuration rules found
        </div>
        <AddHostnameDialog tunnelId={tunnelId} />
      </div>
    );
  }

  const ingressRules = config.config.ingress;
  const publicHostnames = ingressRules
    .filter((rule) => rule.hostname)
    .map((rule) => ({
      hostname: rule.hostname!,
      service: rule.service,
      path: rule.path,
      isWildcard: rule.hostname!.startsWith("*"),
      isCatchAll: !rule.hostname,
    }));

  const handleRemoveHostname = async (hostname: string, path?: string) => {
    try {
      await removeHostname.mutateAsync({
        tunnelId,
        hostname,
        path,
      });

      toast.success(`Hostname ${hostname} removed successfully.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove hostname",
      );
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Public Hostnames & Services</div>
        <AddHostnameDialog tunnelId={tunnelId} />
      </div>

      {publicHostnames.length > 0 ? (
        <div className="space-y-2">
          {publicHostnames.map((hostname, index) => (
            <div
              key={index}
              className="p-3 bg-background rounded border text-xs"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-1 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-sm font-medium break-all">
                      {hostname.hostname}
                    </div>
                    {hostname.isWildcard && (
                      <Badge variant="secondary" className="text-xs">
                        Wildcard
                      </Badge>
                    )}
                  </div>
                  {hostname.path && (
                    <div className="text-muted-foreground">
                      Path: {hostname.path}
                    </div>
                  )}
                  <div className="text-muted-foreground">
                    Service:{" "}
                    <span className="font-mono">{hostname.service}</span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    handleRemoveHostname(hostname.hostname, hostname.path)
                  }
                  disabled={removeHostname.isPending}
                  className="ml-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <IconTrash className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground text-center py-4">
          No public hostnames configured
        </div>
      )}

      {/* Show catch-all rule if it exists */}
      {ingressRules.some((rule) => !rule.hostname) && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-muted-foreground">
            Catch-All Rule
          </div>
          {ingressRules
            .filter((rule) => !rule.hostname)
            .map((rule, index) => (
              <div
                key={index}
                className="p-2 bg-muted/50 rounded border text-xs"
              >
                <div className="text-muted-foreground">
                  Default service:{" "}
                  <span className="font-mono">{rule.service}</span>
                </div>
              </div>
            ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        Configuration version: {config.version} • Source: {config.source}
      </div>
    </div>
  );
}

export function TunnelStatus({ className, managedTunnelIds }: TunnelStatusProps) {
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

  // Auto-expand all tunnels when data loads
  useEffect(() => {
    const tunnelData = tunnels?.data?.tunnels as Tunnel[] | undefined;
    if (tunnelData && tunnelData.length > 0) {
      const allTunnelIds = new Set(tunnelData.map((tunnel) => tunnel.id));
      setExpandedTunnels(allTunnelIds);
    }
  }, [tunnels?.data?.tunnels]);

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

  const formatDate = (
    dateStr: string | null | undefined,
    formatStr: string,
  ): string => {
    if (!dateStr) return "N/A";
    const date = new Date(dateStr);
    if (!isValid(date)) return "Invalid date";
    return format(date, formatStr);
  };

  const handleRefresh = () => {
    refetch();
  };

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconArrowsLeftRight className="h-5 w-5" />
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
            <IconArrowsLeftRight className="h-5 w-5" />
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
            <IconArrowsLeftRight className="h-5 w-5" />
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
                          <div className="font-medium flex items-center gap-2">
                            {tunnel.name}
                            {managedTunnelIds?.has(tunnel.id) && (
                              <Badge variant="secondary" className="text-xs py-0">Managed</Badge>
                            )}
                          </div>
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
                              {formatDate(
                                tunnel.created_at,
                                "MMM d, yyyy HH:mm",
                              )}
                            </div>
                          </div>
                        </div>

                        <div>
                          <div className="text-sm font-medium mb-2">
                            Active Connections
                          </div>
                          <div className="p-2 bg-background rounded border text-sm">
                            {connectionCount > 0 ? (
                              <span>
                                {connectionCount} active{" "}
                                {connectionCount === 1
                                  ? "connection"
                                  : "connections"}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                No active connections
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Tunnel Configuration Section */}
                        <div className="border-t pt-4">
                          <TunnelConfigurationSection tunnelId={tunnel.id} />
                        </div>
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
