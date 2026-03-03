import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconBrandGithub, IconRobot } from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useGitHubSaveAgentToken,
  useGitHubRevokeAgentToken,
} from "@/hooks/use-github-app";
import { TokenInput } from "./token-input";
import type { GitHubAgentAccessLevel } from "@mini-infra/types";

interface AgentAccessSectionProps {
  agentAccessConfigured: boolean;
  agentAccessLevel: GitHubAgentAccessLevel | null;
}

export function AgentAccessSection({
  agentAccessConfigured,
  agentAccessLevel,
}: AgentAccessSectionProps) {
  const saveAgentToken = useGitHubSaveAgentToken();
  const revokeAgentToken = useGitHubRevokeAgentToken();
  const [agentTokenInput, setAgentTokenInput] = useState("");
  const [showAgentTokenInput, setShowAgentTokenInput] = useState(false);
  const [selectedAgentAccessLevel, setSelectedAgentAccessLevel] =
    useState<GitHubAgentAccessLevel>("read_only");

  const handleSaveAgentToken = () => {
    if (!agentTokenInput.trim()) return;
    saveAgentToken.mutate(
      { token: agentTokenInput.trim(), accessLevel: selectedAgentAccessLevel },
      {
        onSuccess: () => {
          toast.success("Assistant GitHub token saved!");
          setAgentTokenInput("");
          setShowAgentTokenInput(false);
        },
        onError: (error) => {
          toast.error(`Failed to save token: ${error.message}`);
        },
      },
    );
  };

  const handleRevokeAgentToken = () => {
    revokeAgentToken.mutate(undefined, {
      onSuccess: () => {
        toast.success("Assistant GitHub token removed");
      },
      onError: (error) => {
        toast.error(`Failed to revoke: ${error.message}`);
      },
    });
  };

  const agentTokenScopes =
    selectedAgentAccessLevel === "read_only"
      ? "repo:status,public_repo,read:org"
      : "repo,workflow,read:org,write:org";

  return (
    <div className="mt-4 p-3 rounded-md border bg-muted/30">
      <div className="text-sm">
        <div className="flex items-center justify-between">
          <p className="font-medium flex items-center gap-1.5">
            <IconRobot className="h-4 w-4" />
            Assistant Access
            {agentAccessConfigured ? (
              <Badge variant="outline" className="ml-1 text-green-600 border-green-600">
                {agentAccessLevel === "full_access" ? "Full Access" : "Read Only"}
              </Badge>
            ) : (
              <Badge variant="outline" className="ml-1 text-amber-600 border-amber-600">Not Configured</Badge>
            )}
          </p>
          {agentAccessConfigured && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive h-7"
              onClick={handleRevokeAgentToken}
              disabled={revokeAgentToken.isPending}
            >
              Remove
            </Button>
          )}
        </div>
        {agentAccessConfigured && (
          <p className="text-muted-foreground mt-1">
            {agentAccessLevel === "full_access"
              ? "The AI assistant has full GitHub access including push, workflow dispatch, and org writes."
              : "The AI assistant has read-only GitHub access for viewing repos, PRs, issues, and org info."}
          </p>
        )}
        {!agentAccessConfigured && (
          <p className="text-muted-foreground mt-1">
            A personal access token for the AI assistant&apos;s <code className="text-xs bg-muted px-1 py-0.5 rounded">gh</code> CLI access.
            Without this, the assistant cannot run GitHub commands.
          </p>
        )}
      </div>

      {!agentAccessConfigured && !showAgentTokenInput && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">Access Level:</label>
            <Select
              value={selectedAgentAccessLevel}
              onValueChange={(v) => setSelectedAgentAccessLevel(v as GitHubAgentAccessLevel)}
            >
              <SelectTrigger className="w-[180px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read_only">Read Only</SelectItem>
                <SelectItem value="full_access">Full Access</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {selectedAgentAccessLevel === "read_only"
              ? "Scopes: repo:status, public_repo, read:org — view repos, PRs, issues, and org info."
              : "Scopes: repo, workflow, read:org, write:org — full repo access, workflow dispatch, and org writes."}
          </p>
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              window.open(
                `https://github.com/settings/tokens/new?description=mini-infra+assistant+access&scopes=${agentTokenScopes}`,
                "_blank",
              );
              setShowAgentTokenInput(true);
            }}
          >
            <IconBrandGithub className="mr-2 h-4 w-4" />
            Generate Token on GitHub
          </Button>
        </div>
      )}

      {!agentAccessConfigured && showAgentTokenInput && (
        <TokenInput
          placeholder="ghp_..."
          promptText="Generate the token on GitHub, then paste it below:"
          value={agentTokenInput}
          onChange={setAgentTokenInput}
          onSave={handleSaveAgentToken}
          onCancel={() => { setShowAgentTokenInput(false); setAgentTokenInput(""); }}
          isSaving={saveAgentToken.isPending}
        />
      )}
    </div>
  );
}
