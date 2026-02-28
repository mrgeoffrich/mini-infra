import { useState } from "react";
import { IconRobot, IconHelpCircle } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const capabilities = [
  "Access all product documentation for accurate, context-aware answers",
  "Call any API endpoint to query live application state",
  "Interact with GitHub via the gh CLI (repos, issues, pull requests)",
  "View and manage Docker containers (start, stop, restart, inspect, logs)",
  "Check deployment status and trigger new deployments",
  "Monitor PostgreSQL backups and database health",
  "Inspect HAProxy load balancer and routing configuration",
  "Check Cloudflare tunnel and connectivity status",
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

export function AgentChatWelcome() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
      <IconRobot className="size-10 text-muted-foreground/50" />
      <span>Ask me anything about your infrastructure.</span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline cursor-pointer"
      >
        <IconHelpCircle className="size-3.5" />
        What can the assistant help me with?
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
