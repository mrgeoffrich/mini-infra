import { useState } from "react";
import {
  IconShieldLock,
  IconLoader2,
  IconRefresh,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconServer,
  IconSettings,
} from "@tabler/icons-react";
import {
  useEgressFwAgentStatus,
  useEgressFwAgentConfig,
  useUpdateEgressFwAgentConfig,
  useRestartEgressFwAgent,
  useStartEgressFwAgent,
  useEgressFwAgentStartupProgress,
} from "@/hooks/use-egress-fw-agent";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

function StatusBadge({ available }: { available: boolean }) {
  return available ? (
    <Badge variant="outline" className="border-green-500 text-green-700 dark:text-green-400">
      <IconCheck className="h-3 w-3 mr-1" />
      Healthy
    </Badge>
  ) : (
    <Badge variant="outline" className="border-red-500 text-red-700 dark:text-red-400">
      <IconX className="h-3 w-3 mr-1" />
      Unavailable
    </Badge>
  );
}

export default function EgressFwAgentSettingsPage() {
  const { data: status, isLoading: statusLoading } = useEgressFwAgentStatus();
  const { data: config, isLoading: configLoading, error: configError } = useEgressFwAgentConfig();
  const { mutate: updateConfig, isPending: isSaving } = useUpdateEgressFwAgentConfig();
  const { mutateAsync: restart, isPending: isRestarting } = useRestartEgressFwAgent();
  const { mutateAsync: start, isPending: isStarting } = useStartEgressFwAgent();

  const [operationId, setOperationId] = useState<string | null>(null);
  const progress = useEgressFwAgentStartupProgress(
    operationId,
    status?.containerRunning ? "Restarting egress fw-agent" : "Starting egress fw-agent",
  );
  const isInProgress = progress.state.phase === "executing";

  // Track unsaved edits as deltas against the persisted config. `null` means
  // "no edit yet; show the saved value". Avoids the lint footgun of syncing
  // server state into local state via useEffect.
  const [imageEdit, setImageEdit] = useState<string | null>(null);
  const [autoStartEdit, setAutoStartEdit] = useState<boolean | null>(null);

  const imageInput = imageEdit ?? config?.image ?? "";
  const autoStart = autoStartEdit ?? config?.autoStart ?? true;

  if (statusLoading || configLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-12 w-64" />
        </div>
      </div>
    );
  }

  if (configError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load fw-agent settings: {configError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const handleStartOrRestart = async () => {
    try {
      const result = status?.containerRunning ? await restart() : await start();
      setOperationId(result.operationId);
    } catch {
      // toast handled by mutation onError
    }
  };

  const imageChanged = imageEdit !== null && imageEdit.trim() !== (config?.image ?? "");
  const autoStartChanged = autoStartEdit !== null && autoStartEdit !== (config?.autoStart ?? true);
  const dirty = imageChanged || autoStartChanged;

  const handleSave = () => {
    if (!dirty) return;
    const updates: { image?: string; autoStart?: boolean } = {};
    if (imageChanged) updates.image = imageInput.trim();
    if (autoStartChanged) updates.autoStart = autoStart;
    updateConfig(updates, {
      onSuccess: () => {
        setImageEdit(null);
        setAutoStartEdit(null);
        toast.success("Egress fw-agent settings saved");
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300">
            <IconShieldLock className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Egress Firewall Agent</h1>
            <p className="text-muted-foreground">
              Host-singleton sidecar that enforces L3/L4 egress rules via nftables
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-4xl space-y-4">
        {/* Status card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconServer className="h-5 w-5" />
              Container Status
            </CardTitle>
            <CardDescription>
              Mini Infra manages this container's lifecycle. nftables rules and the persisted env store
              survive container restarts via host kernel state and the shared `/var/run/mini-infra` volume.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">Admin socket</p>
                <p className="text-xs text-muted-foreground">
                  {status?.available
                    ? `Reachable${status.containerId ? ` (${status.containerId})` : ""}`
                    : status?.containerRunning
                      ? "Container running but admin socket unreachable"
                      : status?.reason ?? "Not running"}
                </p>
              </div>
              <StatusBadge available={!!status?.available} />
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleStartOrRestart}
              disabled={isStarting || isRestarting || isInProgress}
            >
              {isStarting || isRestarting || isInProgress ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconRefresh className="h-4 w-4 mr-2" />
              )}
              {isStarting || isRestarting || isInProgress
                ? "Working..."
                : status?.containerRunning
                  ? "Restart"
                  : "Start"}
            </Button>
          </CardContent>
        </Card>

        {/* Configuration card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconSettings className="h-5 w-5" />
              Configuration
            </CardTitle>
            <CardDescription>
              Database settings override the baked-in image tag. Changes take effect on the next restart.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fw-agent-image">Image</Label>
              <Input
                id="fw-agent-image"
                placeholder="ghcr.io/owner/mini-infra-egress-fw-agent:dev"
                value={imageInput}
                onChange={(e) => setImageEdit(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to use the baked-in default (`EGRESS_FW_AGENT_IMAGE_TAG`).
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="fw-agent-autostart">Auto-start at server boot</Label>
                <p className="text-xs text-muted-foreground">
                  When disabled, the agent must be started manually from this page.
                </p>
              </div>
              <Switch
                id="fw-agent-autostart"
                checked={autoStart}
                onCheckedChange={setAutoStartEdit}
              />
            </div>

            <Button onClick={handleSave} disabled={!dirty || isSaving}>
              {isSaving && <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
