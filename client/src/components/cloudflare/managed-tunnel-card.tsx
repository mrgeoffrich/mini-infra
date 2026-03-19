import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  IconPlus,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
  IconLoader2,
  IconCloudComputing,
} from "@tabler/icons-react";
import type { ManagedTunnelWithStack } from "@mini-infra/types";
import {
  useCreateManagedTunnel,
  useDeleteManagedTunnel,
} from "@/hooks/use-cloudflare-settings";
import { useStackApply, useStackDestroy } from "@/hooks/use-stacks";
import { toast } from "sonner";

interface EnvironmentInfo {
  id: string;
  name: string;
  networkType: string;
}

interface ManagedTunnelCardProps {
  environment: EnvironmentInfo;
  tunnel: ManagedTunnelWithStack | null;
  isCloudflareConfigured: boolean;
}

export function ManagedTunnelCard({
  environment,
  tunnel,
  isCloudflareConfigured,
}: ManagedTunnelCardProps) {
  const [tunnelName, setTunnelName] = useState(
    `mini-infra-${environment.name}`,
  );
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const createMutation = useCreateManagedTunnel();
  const deleteMutation = useDeleteManagedTunnel();
  const applyMutation = useStackApply();
  const destroyMutation = useStackDestroy();

  const isLocalOnly = environment.networkType !== "internet";
  const hasTunnel = !!tunnel;
  const isDeployed = tunnel?.stackStatus === "synced";
  const isPending = tunnel?.stackStatus === "pending";
  const isError = tunnel?.stackStatus === "error";

  const handleCreate = async () => {
    try {
      await createMutation.mutateAsync({
        environmentId: environment.id,
        name: tunnelName,
      });
      setCreateDialogOpen(false);
      toast.success("Managed tunnel created");
    } catch (error) {
      toast.error(
        `Failed to create tunnel: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const handleDeploy = async () => {
    if (!tunnel?.stackId) return;
    try {
      await applyMutation.mutateAsync({
        stackId: tunnel.stackId,
        options: {},
      });
      toast.success("Deploying cloudflared...");
    } catch (error) {
      toast.error(
        `Failed to deploy: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const handleRemove = async () => {
    if (!tunnel?.stackId) return;
    try {
      await destroyMutation.mutateAsync(tunnel.stackId);
      toast.success("Removing cloudflared...");
    } catch (error) {
      toast.error(
        `Failed to remove: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(environment.id);
      toast.success("Managed tunnel deleted");
    } catch (error) {
      toast.error(
        `Failed to delete tunnel: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const statusBadge = () => {
    if (!hasTunnel) return null;
    if (isDeployed)
      return <Badge variant="default" className="bg-green-600">Running</Badge>;
    if (isPending)
      return <Badge variant="secondary">Pending</Badge>;
    if (isError)
      return <Badge variant="destructive">Error</Badge>;
    return <Badge variant="outline">Not Deployed</Badge>;
  };

  return (
    <Card className={isLocalOnly ? "opacity-60" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconCloudComputing className="h-5 w-5 text-orange-500" />
            <CardTitle className="text-base">{environment.name}</CardTitle>
            {statusBadge()}
            {isLocalOnly && (
              <Badge variant="outline" className="text-muted-foreground">
                Local Only
              </Badge>
            )}
          </div>
        </div>
        {hasTunnel && (
          <CardDescription className="text-xs">
            Tunnel: {tunnel.tunnelName} ({tunnel.tunnelId.slice(0, 8)}...)
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          {/* No tunnel yet — show create button */}
          {!hasTunnel && !isLocalOnly && (
            <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  disabled={!isCloudflareConfigured}
                  title={
                    !isCloudflareConfigured
                      ? "Configure Cloudflare first"
                      : undefined
                  }
                >
                  <IconPlus className="h-4 w-4 mr-1" />
                  Create Tunnel
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Managed Tunnel</DialogTitle>
                  <DialogDescription>
                    Create a Cloudflare tunnel for the{" "}
                    <strong>{environment.name}</strong> environment. This will
                    create a tunnel in your Cloudflare account.
                  </DialogDescription>
                </DialogHeader>
                <div className="py-4">
                  <label className="text-sm font-medium" htmlFor="tunnel-name">
                    Tunnel Name
                  </label>
                  <Input
                    id="tunnel-name"
                    value={tunnelName}
                    onChange={(e) => setTunnelName(e.target.value)}
                    placeholder="my-tunnel"
                    className="mt-1"
                  />
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setCreateDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreate}
                    disabled={
                      createMutation.isPending || !tunnelName.trim()
                    }
                  >
                    {createMutation.isPending && (
                      <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                    )}
                    Create
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

          {/* Tunnel exists but not deployed */}
          {hasTunnel && !isDeployed && tunnel.stackId && (
            <Button
              size="sm"
              onClick={handleDeploy}
              disabled={
                applyMutation.isPending || !tunnel.hasToken
              }
            >
              {applyMutation.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <IconPlayerPlay className="h-4 w-4 mr-1" />
              )}
              Deploy
            </Button>
          )}

          {/* Tunnel is deployed — show remove button */}
          {hasTunnel && isDeployed && tunnel.stackId && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRemove}
              disabled={destroyMutation.isPending}
            >
              {destroyMutation.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <IconPlayerStop className="h-4 w-4 mr-1" />
              )}
              Remove
            </Button>
          )}

          {/* Delete tunnel */}
          {hasTunnel && !isDeployed && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={deleteMutation.isPending}
                >
                  <IconTrash className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Managed Tunnel?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will delete the tunnel "{tunnel.tunnelName}" from your
                    Cloudflare account. Any hostnames configured on this tunnel
                    will stop working.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {/* Local-only environment notice */}
          {isLocalOnly && (
            <p className="text-xs text-muted-foreground">
              Only internet-facing environments can have managed tunnels
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
