import { useState } from "react";
import {
  IconServer,
  IconRobot,
  IconLoader2,
  IconCheck,
  IconX,
} from "@tabler/icons-react";
import { useAgentChat } from "@/hooks/use-agent-chat";
import {
  useUpdateAgentSettings,
  useValidateAgentApiKey,
} from "@/hooks/use-agent-settings";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WelcomeLabelsOverlay, type LabelDef } from "./WelcomeArrowOverlay";

const LABELS: LabelDef[] = [
  { tourTarget: "header-connectivity", label: "Service Connectivity" },
  {
    tourTarget: "header-assisted-setup",
    label: "Assisted Setup",
    requiresAgent: true,
  },
  { tourTarget: "header-help", label: "Help & Docs" },
  {
    tourTarget: "agent-chat-fab",
    label: "AI Assistant",
    requiresAgent: true,
    anchor: "above",
  },
];

function ApiKeySetupInline() {
  const [apiKey, setApiKey] = useState("");
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    message: string;
  } | null>(null);
  const { mutate: validateKey, isPending: isValidating } =
    useValidateAgentApiKey();
  const { mutate: updateSettings, isPending: isSaving } =
    useUpdateAgentSettings();
  const { refetch: refetchStatus } = useAgentStatus();

  const handleValidate = () => {
    if (!apiKey.trim()) return;
    setValidationResult(null);
    validateKey(apiKey.trim(), {
      onSuccess: (result) => {
        setValidationResult({ valid: result.valid, message: result.message });
      },
      onError: (err) => {
        setValidationResult({ valid: false, message: err.message });
      },
    });
  };

  const handleSave = () => {
    if (!apiKey.trim()) return;
    updateSettings(
      { apiKey: apiKey.trim() },
      {
        onSuccess: () => {
          setApiKey("");
          setValidationResult(null);
          refetchStatus();
        },
      },
    );
  };

  return (
    <div className="mt-6 mx-auto max-w-md text-left space-y-3">
      <div className="flex items-center gap-2 justify-center text-sm font-medium text-muted-foreground">
        <IconRobot className="h-4 w-4" />
        Enable the AI Assistant to get started faster
      </div>
      <Input
        type="password"
        placeholder="Enter your Anthropic API key (sk-ant-...)"
        value={apiKey}
        onChange={(e) => {
          setApiKey(e.target.value);
          setValidationResult(null);
        }}
      />
      {validationResult && (
        <Alert
          variant={validationResult.valid ? "default" : "destructive"}
          className="py-2"
        >
          {validationResult.valid ? (
            <IconCheck className="h-4 w-4" />
          ) : (
            <IconX className="h-4 w-4" />
          )}
          <AlertDescription className="text-xs">
            {validationResult.message}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2 justify-center">
        <Button
          variant="outline"
          size="sm"
          onClick={handleValidate}
          disabled={!apiKey.trim() || isValidating}
        >
          {isValidating && (
            <IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          )}
          Validate
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!apiKey.trim() || isSaving}
        >
          {isSaving && (
            <IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          )}
          Save & Enable
        </Button>
      </div>
    </div>
  );
}

export function WelcomeDashboard() {
  const { agentEnabled } = useAgentChat();

  const visibleLabels = LABELS.filter(
    (l) => !l.requiresAgent || agentEnabled,
  );

  return (
    <div className="px-4 lg:px-6">
      <div className="rounded-xl border-2 border-dashed border-muted-foreground/25 bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <IconServer className="size-7 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          Welcome to Mini Infra
        </h2>
        {agentEnabled ? (
          <p className="text-muted-foreground mt-2 max-w-lg mx-auto">
            Your single-host Docker management dashboard. Connect your services
            to get started.
          </p>
        ) : (
          <ApiKeySetupInline />
        )}
      </div>

      <WelcomeLabelsOverlay labels={visibleLabels} />
    </div>
  );
}
