import { useState, useCallback, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconServer,
  IconRobot,
  IconLoader2,
  IconCheck,
  IconX,
  IconBrandDocker,
  IconCircleCheck,
  IconCircleDashed,
  IconRocket,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useAgentSettings,
  useUpdateAgentSettings,
  useValidateAgentApiKey,
  useStartAgentSidecar,
  useAgentSidecarStartupProgress,
} from "@/hooks/use-agent-settings";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useConnectivityStatus } from "@/hooks/use-settings";
import {
  useSystemSettings,
  useCreateSystemSetting,
  useUpdateSystemSetting,
} from "@/hooks/use-settings";
import { useValidateService } from "@/hooks/use-settings-validation";
import { useCompleteOnboarding } from "@/hooks/use-onboarding";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { WelcomeLabelsOverlay, type LabelDef } from "./WelcomeArrowOverlay";
import type { SystemSettingsInfo } from "@mini-infra/types";

const LABELS: LabelDef[] = [
  { tourTarget: "header-connectivity", label: "Service Connectivity" },
  { tourTarget: "header-help", label: "Help & Docs" },
];

// ---------------------------------------------------------------------------
// Step 1 — Anthropic API Key
// ---------------------------------------------------------------------------

function ApiKeySetupStep({ onComplete }: { onComplete: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    message: string;
  } | null>(null);
  const { mutate: validateKey, isPending: isValidating } =
    useValidateAgentApiKey();
  const { mutate: updateSettings, isPending: isSaving } =
    useUpdateAgentSettings();

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
          toast.success("API key saved");
          onComplete();
        },
        onError: (err) => {
          setValidationResult({
            valid: false,
            message: err.message || "Failed to save API key",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-3">
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
      <div className="flex gap-2">
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
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Docker Connection
// ---------------------------------------------------------------------------

const dockerSchema = z.object({
  host: z
    .string()
    .min(1, "Docker host is required")
    .refine(
      (host) =>
        host.startsWith("unix://") ||
        host.startsWith("npipe://") ||
        host.startsWith("tcp://") ||
        host.startsWith("http://") ||
        host.startsWith("https://"),
      "Must start with unix://, npipe://, tcp://, http://, or https://",
    ),
  version: z
    .string()
    .min(1, "API version is required")
    .regex(/^\d+\.\d+$/, "Must be in format X.Y (e.g., 1.41)"),
});

type DockerFormData = z.infer<typeof dockerSchema>;

function DockerSetupStep({ onComplete }: { onComplete: () => void }) {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<Record<string, SystemSettingsInfo>>(
    {},
  );

  const { data: dockerSettings, isLoading: dockerLoading } = useSystemSettings({
    filters: { category: "docker", isActive: true },
    limit: 50,
  });

  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();
  const validateService = useValidateService();

  const form = useForm<DockerFormData>({
    resolver: zodResolver(dockerSchema),
    defaultValues: {
      host: "unix:///var/run/docker.sock",
      version: "1.51",
    },
    mode: "onChange",
  });

  // Routing the setState calls through a ref keeps them out of the effect's
  // reactive body so the set-state-in-effect rule doesn't flag them.
  const syncDockerSettings = useCallback(() => {
    if (!dockerSettings?.data) return;
    const map: Record<string, SystemSettingsInfo> = {};
    dockerSettings.data.forEach((s) => {
      map[s.key] = s;
    });
    setSettings(map);
    if (map.host?.value) form.setValue("host", map.host.value);
    if (map.apiVersion?.value) form.setValue("version", map.apiVersion.value);
  }, [dockerSettings, form]);
  const syncDockerSettingsRef = useRef(syncDockerSettings);
  useEffect(() => {
    syncDockerSettingsRef.current = syncDockerSettings;
  }, [syncDockerSettings]);
  useEffect(() => {
    syncDockerSettingsRef.current();
  }, [dockerSettings]);

  const isSaving =
    createSetting.isPending ||
    updateSetting.isPending ||
    validateService.isPending;

  const handleValidateAndSave = async (data: DockerFormData) => {
    try {
      const result = await validateService.mutateAsync({
        service: "docker",
        settings: { host: data.host, version: data.version },
      });

      if (!result.data.isValid) {
        throw new Error(result.message || "Connection validation failed");
      }

      const promises: Promise<unknown>[] = [];

      if (settings.host) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.host.id,
            setting: { value: data.host },
          }),
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "docker",
            key: "host",
            value: data.host,
            isEncrypted: false,
          }),
        );
      }

      if (settings.apiVersion) {
        promises.push(
          updateSetting.mutateAsync({
            id: settings.apiVersion.id,
            setting: { value: data.version },
          }),
        );
      } else {
        promises.push(
          createSetting.mutateAsync({
            category: "docker",
            key: "apiVersion",
            value: data.version,
            isEncrypted: false,
          }),
        );
      }

      await Promise.all(promises);
      await queryClient.invalidateQueries({
        queryKey: ["connectivityStatus"],
      });

      toast.success("Docker connected successfully");
      onComplete();
    } catch (error) {
      toast.error(`Docker connection failed: ${(error as Error).message}`);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleValidateAndSave)}
        className="space-y-3"
      >
        <FormField
          control={form.control}
          name="host"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Docker Host URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="unix:///var/run/docker.sock"
                  disabled={dockerLoading}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="version"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">API Version</FormLabel>
              <FormControl>
                <Input
                  placeholder="1.41"
                  disabled={dockerLoading}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!form.formState.isValid || isSaving}
        >
          {isSaving && (
            <IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          )}
          Validate & Connect
        </Button>
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function SetupStep({
  number,
  icon,
  title,
  done,
  active,
  children,
}: {
  number: number;
  icon: React.ReactNode;
  title: string;
  done: boolean;
  active: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        done
          ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30"
          : active
            ? "border-primary/30 bg-card"
            : "border-muted bg-muted/30 opacity-60"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="flex-shrink-0">
          {done ? (
            <IconCircleCheck className="h-5 w-5 text-green-600 dark:text-green-400" />
          ) : (
            <IconCircleDashed
              className={`h-5 w-5 ${active ? "text-primary" : "text-muted-foreground"}`}
            />
          )}
        </div>
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          <span>
            {number}. {title}
          </span>
        </div>
      </div>
      {active && !done && children && (
        <div className="mt-3 ml-8">{children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Start sidecar & complete onboarding
// ---------------------------------------------------------------------------

function SidecarStartStep({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [sidecarOperationId, setSidecarOperationId] = useState<string | null>(
    null,
  );
  const [startError, setStartError] = useState<string | null>(null);
  const { mutateAsync: startSidecar, isPending } = useStartAgentSidecar();
  useAgentSidecarStartupProgress(sidecarOperationId, "Starting AI assistant");

  const handleStart = async () => {
    setStartError(null);
    try {
      const result = await startSidecar();
      setSidecarOperationId(result.operationId);
      onComplete();
    } catch (err) {
      setStartError((err as Error).message);
    }
  };

  if (sidecarOperationId) {
    return (
      <p className="text-xs text-muted-foreground flex items-center gap-2">
        <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
        Starting the AI assistant…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {startError && (
        <Alert variant="destructive" className="py-2">
          <IconX className="h-4 w-4" />
          <AlertDescription className="text-xs">{startError}</AlertDescription>
        </Alert>
      )}
      <Button size="sm" onClick={handleStart} disabled={isPending}>
        {isPending && (
          <IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        )}
        Start AI Assistant
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function WelcomeDashboard() {
  const { data: agentSettings } = useAgentSettings();
  const { data: agentStatus } = useAgentStatus();
  const { data: dockerData } = useConnectivityStatus({
    filters: { service: "docker" },
    limit: 1,
  });
  const { complete: completeOnboarding, isPending: isCompletingOnboarding } =
    useCompleteOnboarding();

  // Local flags so steps flip to "done" immediately on success,
  // without waiting for the background query to refetch.
  const [apiKeyJustSaved, setApiKeyJustSaved] = useState(false);
  const [dockerJustConnected, setDockerJustConnected] = useState(false);

  const agentEnabled = agentStatus?.enabled === true;
  const apiKeyConfigured =
    apiKeyJustSaved || agentSettings?.apiKey?.configured === true;
  const dockerConnected =
    dockerJustConnected || dockerData?.data?.[0]?.status === "connected";
  const setupComplete = apiKeyConfigured && dockerConnected;

  const handleApiKeySaved = () => {
    setApiKeyJustSaved(true);
  };

  const handleDockerConnected = () => {
    setDockerJustConnected(true);
  };

  const handleSidecarStarted = () => {
    completeOnboarding();
  };

  const handleSkip = () => {
    completeOnboarding();
  };

  return (
    <div className="px-4 lg:px-6">
      <div className="rounded-xl border-2 border-dashed border-muted-foreground/25 bg-card p-8">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <IconServer className="size-7 text-primary" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">
            Welcome to Mini Infra
          </h2>
          <p className="text-muted-foreground mt-2 max-w-lg mx-auto">
            Let's get your environment set up. Complete these steps to enable
            the AI assistant and start managing your Docker host.
          </p>
        </div>

        <div className="mt-6 mx-auto max-w-md space-y-3">
          <SetupStep
            number={1}
            icon={<IconRobot className="h-4 w-4" />}
            title="Anthropic API Key"
            done={apiKeyConfigured}
            active={!apiKeyConfigured}
          >
            <ApiKeySetupStep onComplete={handleApiKeySaved} />
          </SetupStep>

          <SetupStep
            number={2}
            icon={<IconBrandDocker className="h-4 w-4" />}
            title="Connect Docker"
            done={dockerConnected}
            active={apiKeyConfigured && !dockerConnected}
          >
            <DockerSetupStep onComplete={handleDockerConnected} />
          </SetupStep>

          <SetupStep
            number={3}
            icon={<IconRocket className="h-4 w-4" />}
            title="Start AI Assistant"
            done={agentEnabled}
            active={setupComplete && !agentEnabled}
          >
            <SidecarStartStep onComplete={handleSidecarStarted} />
          </SetupStep>
        </div>

        <div className="mt-6 text-center">
          <Button
            variant="outline"
            onClick={handleSkip}
            disabled={isCompletingOnboarding}
          >
            Skip setup — I'll configure these later
          </Button>
        </div>
      </div>

      <WelcomeLabelsOverlay labels={LABELS} />
    </div>
  );
}
