import { useState, useEffect } from "react";
import {
  IconRobot,
  IconLoader2,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconRefreshAlert,
} from "@tabler/icons-react";
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
import {
  useAgentSidecarStatus,
  useAgentSidecarConfig,
  useUpdateAgentSidecarConfig,
  useRestartAgentSidecar,
} from "@/hooks/use-agent-sidecar";

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export default function AgentSidecarSettingsPage() {
  const { data: status, isLoading: statusLoading } = useAgentSidecarStatus();
  const { data: config, isLoading: configLoading, error: configError } = useAgentSidecarConfig();
  const { mutate: updateConfig, isPending: isSaving } = useUpdateAgentSidecarConfig();
  const { mutate: restart, isPending: isRestarting } = useRestartAgentSidecar();

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState("");
  const [maxTurns, setMaxTurns] = useState(50);
  const [timeoutMinutes, setTimeoutMinutes] = useState(5);
  const [autoStart, setAutoStart] = useState(false);
  const [image, setImage] = useState("");

  // Sync config into form state
  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setModel(config.model);
      setMaxTurns(config.maxTurns);
      setTimeoutMinutes(Math.round(config.timeoutMs / 60000));
      setAutoStart(config.autoStart);
      setImage(config.image ?? "");
    }
  }, [config]);

  const isLoading = statusLoading || configLoading;

  if (isLoading) {
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
              Failed to load sidecar configuration: {configError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const handleSave = () => {
    updateConfig(
      {
        enabled,
        model: model.trim() || undefined,
        maxTurns,
        timeoutMs: timeoutMinutes * 60000,
        autoStart,
        image: image.trim() || undefined,
      },
      {
        onSuccess: () => toast.success("Configuration saved"),
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const handleRestart = () => {
    restart(undefined, {
      onSuccess: () => toast.success("Sidecar restarted"),
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconRobot className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Agent Sidecar</h1>
            <p className="text-muted-foreground">
              Configure the AI agent sidecar container for background tasks
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-4">
        {/* Card 1: Sidecar Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Status
              {status?.available ? (
                <Badge variant="outline" className="border-green-500 text-green-700 dark:text-green-400">
                  <IconCheck className="h-3 w-3 mr-1" />
                  Available
                </Badge>
              ) : (
                <Badge variant="outline" className="border-red-500 text-red-700 dark:text-red-400">
                  <IconX className="h-3 w-3 mr-1" />
                  Unavailable
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Current state of the agent sidecar container
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Container</Label>
                <p className="text-sm font-medium">
                  {status?.containerRunning ? "Running" : "Stopped"}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Health</Label>
                <p className="text-sm font-medium">
                  {status?.health?.status ?? "—"}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Uptime</Label>
                <p className="text-sm font-medium">
                  {formatUptime(status?.health?.uptime ?? null)}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Tasks Processed</Label>
                <p className="text-sm font-medium">
                  {status?.health?.totalTasksProcessed ?? "—"}
                </p>
              </div>
            </div>

            <Button
              variant="outline"
              onClick={handleRestart}
              disabled={isRestarting}
            >
              {isRestarting ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconRefreshAlert className="h-4 w-4 mr-2" />
              )}
              Restart Sidecar
            </Button>
          </CardContent>
        </Card>

        {/* Card 2: Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>
              Agent sidecar settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Enabled</Label>
                <p className="text-xs text-muted-foreground">
                  Enable the agent sidecar container
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="sidecar-model">Model</Label>
              <Input
                id="sidecar-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-sonnet-4-20250514"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="sidecar-max-turns">Max Turns</Label>
              <Input
                id="sidecar-max-turns"
                type="number"
                min={1}
                max={200}
                value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Maximum number of agent turns per task (1–200)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sidecar-timeout">Timeout (minutes)</Label>
              <Input
                id="sidecar-timeout"
                type="number"
                min={1}
                max={10}
                value={timeoutMinutes}
                onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Auto Start</Label>
                <p className="text-xs text-muted-foreground">
                  Automatically start the sidecar when the server starts
                </p>
              </div>
              <Switch checked={autoStart} onCheckedChange={setAutoStart} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="sidecar-image">Docker Image</Label>
              <Input
                id="sidecar-image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="Default image"
              />
              <p className="text-xs text-muted-foreground">
                Custom Docker image for the sidecar container (leave empty for default)
              </p>
            </div>

            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
