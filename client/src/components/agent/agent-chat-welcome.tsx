import { useState } from "react";
import { IconRobot, IconHelpCircle, IconAlertTriangle, IconSettings } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useConnectivityStatus } from "@/hooks/use-settings";

const capabilities = [
  "Access all product documentation for accurate, context-aware answers",
  "Access to all this applications capabilities, equivalent to this applications UI",
  "Interact with GitHub via the gh CLI (repos, issues, pull requests)",
  "View and manage Docker containers (start, stop, restart, inspect, logs)",
  "Guide you through the UI with visual highlights",
];

const examplePrompts = [
  "Show me which containers are running",
  "What's the status of my latest deployment?",
  "Are my database backups up to date?",
  "Check the logs for the mini-infra container",
  "Take me to the deployments page",
  "Create a GitHub issue for...",
];

function useHasDisconnectedServices() {
  const { data: dockerData } = useConnectivityStatus({ filters: { service: "docker" }, limit: 1 });
  const { data: cloudflareData } = useConnectivityStatus({ filters: { service: "cloudflare" }, limit: 1 });
  const { data: azureData } = useConnectivityStatus({ filters: { service: "azure" }, limit: 1 });
  const { data: githubData } = useConnectivityStatus({ filters: { service: "github-app" }, limit: 1 });

  return [dockerData, cloudflareData, azureData, githubData].some(
    (data) => data?.data?.[0] && data.data[0].status !== "connected",
  );
}

export function AgentChatWelcome() {
  const [open, setOpen] = useState(false);
  const { data: status } = useAgentStatus();
  const { sendMessage } = useAgentChat();
  const hasDisconnected = useHasDisconnectedServices();

  // Show unavailable message when sidecar is not running
  if (status && !status.enabled) {
    const reason = status.reason;
    let message = "The AI assistant is currently unavailable.";
    let detail = "Check the AI Assistant settings page for configuration.";

    if (reason === "sidecar_unavailable" || reason === "sidecar_unhealthy") {
      message = "The AI assistant requires the sidecar container.";
      detail =
        "The agent sidecar container is not running. Enable it in Settings > AI Assistant or restart it from the sidecar settings.";
    } else if (reason === "api_key_not_configured") {
      message = "The AI assistant needs an API key.";
      detail =
        "Configure an Anthropic API key in Settings > AI Assistant to enable the assistant.";
    }

    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
        <IconAlertTriangle className="size-10 text-amber-500/60" />
        <span className="font-medium text-foreground">{message}</span>
        <span className="text-xs text-center max-w-xs">{detail}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
      <IconRobot className="size-10 text-muted-foreground/50" />
      <span>Ask me anything about your infrastructure.</span>
      {hasDisconnected && (
        <button
          type="button"
          onClick={() => sendMessage("Help me set up my disconnected services")}
          className="mt-1 flex flex-col items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-5 py-3 text-center transition-colors hover:border-amber-500/50 hover:bg-amber-500/10 cursor-pointer"
        >
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
            <IconSettings className="size-4" />
            Guided service setup
          </span>
          <span className="text-xs text-muted-foreground">
            Some services are disconnected — let me help you configure them
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex flex-col items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-5 py-3 text-center transition-colors hover:border-primary/40 hover:bg-primary/10 cursor-pointer"
      >
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
          <IconHelpCircle className="size-4" />
          What can the assistant help me with?
        </span>
        <span className="text-xs text-muted-foreground">
          See what the agent can do and how it can help you
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>What can the assistant do?</DialogTitle>
            <DialogDescription>
              Your AI infrastructure assistant can help with a variety of tasks.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <div>
              <h4 className="font-medium mb-2">Capabilities</h4>
              <ul className="space-y-1 text-muted-foreground">
                {capabilities.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="shrink-0">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-medium mb-2">Example prompts</h4>
              <ul className="space-y-1 text-muted-foreground">
                {examplePrompts.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="shrink-0">"</span>
                    <span className="italic">{item}</span>
                    <span className="shrink-0">"</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
