import { useState } from "react";
import {
  IconRobot,
  IconLoader2,
  IconKey,
  IconBrandDocker,
  IconBrandGithub,
  IconApi,
  IconSettings,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconInfoCircle,
  IconTrash,
  IconRefresh,
  IconServer,
} from "@tabler/icons-react";
import {
  useAgentSettings,
  useUpdateAgentSettings,
  useValidateAgentApiKey,
  useDeleteAgentApiKey,
  useAgentSidecarStatus,
  useRestartAgentSidecar,
} from "@/hooks/use-agent-settings";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

function StatusBadge({ available }: { available: boolean }) {
  return available ? (
    <Badge variant="outline" className="border-green-500 text-green-700 dark:text-green-400">
      <IconCheck className="h-3 w-3 mr-1" />
      Available
    </Badge>
  ) : (
    <Badge variant="outline" className="border-red-500 text-red-700 dark:text-red-400">
      <IconX className="h-3 w-3 mr-1" />
      Unavailable
    </Badge>
  );
}

export default function AiAssistantSettingsPage() {
  const { data: settings, isLoading, error } = useAgentSettings();
  const { mutate: updateSettings, isPending: isSaving } = useUpdateAgentSettings();
  const { mutate: validateKey, isPending: isValidating } = useValidateAgentApiKey();
  const { mutate: deleteKey, isPending: isDeleting } = useDeleteAgentApiKey();
  const { data: sidecarStatus } = useAgentSidecarStatus();
  const { mutate: restartSidecar, isPending: isRestarting } = useRestartAgentSidecar();

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    message: string;
  } | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-12 w-64" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load AI assistant settings: {error.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  const handleValidate = () => {
    if (!apiKeyInput.trim()) return;
    setValidationResult(null);
    validateKey(apiKeyInput.trim(), {
      onSuccess: (result) => {
        setValidationResult({ valid: result.valid, message: result.message });
      },
      onError: (err) => {
        setValidationResult({ valid: false, message: err.message });
      },
    });
  };

  const handleSaveApiKey = () => {
    if (!apiKeyInput.trim()) return;
    updateSettings(
      { apiKey: apiKeyInput.trim() },
      {
        onSuccess: () => {
          setApiKeyInput("");
          setValidationResult(null);
          toast.success("API key saved successfully");
        },
        onError: (err) => {
          toast.error(err.message);
        },
      },
    );
  };

  const handleDeleteApiKey = () => {
    deleteKey(undefined, {
      onSuccess: () => {
        toast.success("API key removed");
      },
      onError: (err) => {
        toast.error(err.message);
      },
    });
  };

  const handleSaveModel = () => {
    if (!selectedModel) return;
    updateSettings(
      { model: selectedModel },
      {
        onSuccess: () => {
          setSelectedModel(null);
          toast.success("Model updated successfully");
        },
        onError: (err) => {
          toast.error(err.message);
        },
      },
    );
  };

  const handleRestartSidecar = () => {
    restartSidecar(undefined, {
      onSuccess: () => {
        toast.success("Sidecar container restarted");
      },
      onError: (err) => {
        toast.error(err.message);
      },
    });
  };

  const modelValue = selectedModel ?? settings.model.current;
  const modelChanged = selectedModel !== null && selectedModel !== settings.model.current;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconRobot className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">AI Assistant</h1>
            <p className="text-muted-foreground">
              Configure the AI assistant's API key, model, and sidecar container
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-4">
        {/* Card 0: Sidecar Container Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconServer className="h-5 w-5" />
              Sidecar Container
            </CardTitle>
            <CardDescription>
              The AI assistant runs in an isolated sidecar container for safety
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">Container Status</p>
                <p className="text-xs text-muted-foreground">
                  {sidecarStatus?.available
                    ? `Running${sidecarStatus.containerId ? ` (${sidecarStatus.containerId})` : ""}`
                    : sidecarStatus?.containerRunning
                      ? "Container running but unhealthy"
                      : "Not running"}
                </p>
              </div>
              <StatusBadge available={!!sidecarStatus?.available} />
            </div>

            {sidecarStatus?.health && (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Uptime</Label>
                  <p className="text-sm font-medium">
                    {Math.floor((sidecarStatus.health as { uptime: number }).uptime / 60)}m
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Active Sessions</Label>
                  <p className="text-sm font-medium">
                    {(sidecarStatus.health as { activeSessions?: number; activeTasks?: number }).activeSessions ??
                      (sidecarStatus.health as { activeTasks?: number }).activeTasks ?? 0}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Total Processed</Label>
                  <p className="text-sm font-medium">
                    {(sidecarStatus.health as { totalSessionsProcessed?: number; totalTasksProcessed?: number }).totalSessionsProcessed ??
                      (sidecarStatus.health as { totalTasksProcessed?: number }).totalTasksProcessed ?? 0}
                  </p>
                </div>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={handleRestartSidecar}
              disabled={isRestarting}
            >
              {isRestarting ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconRefresh className="h-4 w-4 mr-2" />
              )}
              {sidecarStatus?.available ? "Restart" : "Start"} Sidecar
            </Button>
          </CardContent>
        </Card>

        {/* Card 1: API Key Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconKey className="h-5 w-5" />
              API Key Configuration
            </CardTitle>
            <CardDescription>
              Provide an Anthropic API key to enable the AI assistant
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings.apiKey.source === "environment" && (
              <div className="rounded-md bg-blue-50 p-4 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-100">
                <div className="flex items-start gap-2">
                  <IconInfoCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Set via environment variable</p>
                    <p className="mt-1 text-blue-700 dark:text-blue-200">
                      The API key is configured through the <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">ANTHROPIC_API_KEY</code> environment variable.
                      To change it, update the environment variable and restart the server.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {settings.apiKey.configured && settings.apiKey.maskedKey && (
              <div className="space-y-2">
                <Label>Current API Key</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border bg-muted px-3 py-2 text-sm font-mono">
                    {settings.apiKey.maskedKey}
                  </code>
                  {settings.apiKey.source === "database" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleDeleteApiKey}
                      disabled={isDeleting}
                    >
                      {isDeleting ? (
                        <IconLoader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <IconTrash className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Source: {settings.apiKey.source}
                </p>
              </div>
            )}

            {settings.apiKey.source !== "environment" && (
              <div className="space-y-2">
                <Label htmlFor="api-key">
                  {settings.apiKey.source === "database" ? "Change API Key" : "Anthropic API Key"}
                </Label>
                <Input
                  id="api-key"
                  type="password"
                  placeholder="sk-ant-..."
                  value={apiKeyInput}
                  onChange={(e) => {
                    setApiKeyInput(e.target.value);
                    setValidationResult(null);
                  }}
                />

                {validationResult && (
                  <Alert variant={validationResult.valid ? "default" : "destructive"}>
                    {validationResult.valid ? (
                      <IconCheck className="h-4 w-4" />
                    ) : (
                      <IconX className="h-4 w-4" />
                    )}
                    <AlertDescription>{validationResult.message}</AlertDescription>
                  </Alert>
                )}

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleValidate}
                    disabled={!apiKeyInput.trim() || isValidating}
                  >
                    {isValidating && <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Validate
                  </Button>
                  <Button
                    onClick={handleSaveApiKey}
                    disabled={!apiKeyInput.trim() || isSaving}
                  >
                    {isSaving && <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Save
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Card 2: Model Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconRobot className="h-5 w-5" />
              Model Selection
            </CardTitle>
            <CardDescription>
              Choose which Claude model the AI assistant uses
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings.model.source === "environment" && (
              <div className="rounded-md bg-blue-50 p-4 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-100">
                <div className="flex items-start gap-2">
                  <IconInfoCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Overridden by environment variable</p>
                    <p className="mt-1 text-blue-700 dark:text-blue-200">
                      The model is set via the <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">AGENT_MODEL</code> environment variable.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="model-select">Model</Label>
              <Select
                value={modelValue}
                onValueChange={(value) => setSelectedModel(value)}
                disabled={settings.model.source === "environment"}
              >
                <SelectTrigger id="model-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {settings.model.available.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Source: {settings.model.source}
              </p>
            </div>

            {modelChanged && (
              <Button
                onClick={handleSaveModel}
                disabled={isSaving}
              >
                {isSaving && <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Model
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Card 3: Capabilities */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconSettings className="h-5 w-5" />
              Capabilities
            </CardTitle>
            <CardDescription>
              Services available to the AI assistant
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <IconApi className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium text-sm">API Access</p>
                  <p className="text-xs text-muted-foreground">
                    The assistant has full internal API access via a dedicated service key
                  </p>
                </div>
              </div>
              <StatusBadge available={settings.capabilities.api.available} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <IconBrandDocker className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium text-sm">Docker</p>
                  <p className="text-xs text-muted-foreground">
                    Socket: {settings.capabilities.docker.socketPath}
                  </p>
                </div>
              </div>
              <StatusBadge available={settings.capabilities.docker.available} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <IconBrandGithub className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium text-sm">GitHub</p>
                  <p className="text-xs text-muted-foreground">
                    {settings.capabilities.github.available
                      ? "Agent token configured"
                      : "Configure via Connectivity > GitHub"}
                  </p>
                </div>
              </div>
              <StatusBadge available={settings.capabilities.github.available} />
            </div>
          </CardContent>
        </Card>

        {/* Card 4: Advanced Settings (read-only) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconSettings className="h-5 w-5" />
              Advanced Settings
            </CardTitle>
            <CardDescription>
              These settings are configured via environment variables
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Thinking Mode</Label>
                <p className="text-sm font-medium">{settings.advanced.thinking}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Effort Level</Label>
                <p className="text-sm font-medium">{settings.advanced.effort}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Max Turns</Label>
                <p className="text-sm font-medium">{settings.advanced.maxTurns}</p>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Set via <code>AGENT_THINKING</code>, <code>AGENT_EFFORT</code>, and <code>AGENT_MAX_TURNS</code> environment variables.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
