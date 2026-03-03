import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconBrandGithub, IconKey } from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useGitHubSavePackagePat,
  useGitHubOAuthRevoke,
} from "@/hooks/use-github-app";
import { TokenInput } from "./token-input";

interface PackageAccessSectionProps {
  oauthAuthorized: boolean;
}

export function PackageAccessSection({
  oauthAuthorized,
}: PackageAccessSectionProps) {
  const savePat = useGitHubSavePackagePat();
  const oauthRevoke = useGitHubOAuthRevoke();
  const [patInput, setPatInput] = useState("");
  const [showPatInput, setShowPatInput] = useState(false);

  const handleSavePat = () => {
    if (!patInput.trim()) return;
    savePat.mutate(
      { token: patInput.trim() },
      {
        onSuccess: () => {
          toast.success("Token saved! GHCR packages should now be visible.");
          setPatInput("");
          setShowPatInput(false);
        },
        onError: (error) => {
          toast.error(`Failed to save token: ${error.message}`);
        },
      },
    );
  };

  const handleRevokePat = () => {
    oauthRevoke.mutate(undefined, {
      onSuccess: () => {
        toast.success("Package access token removed");
      },
      onError: (error) => {
        toast.error(`Failed to revoke: ${error.message}`);
      },
    });
  };

  return (
    <div className="mt-4 p-3 rounded-md border bg-muted/30">
      <div className="text-sm">
        <div className="flex items-center justify-between">
          <p className="font-medium flex items-center gap-1.5">
            <IconKey className="h-4 w-4" />
            Package Access
            {oauthAuthorized ? (
              <Badge variant="outline" className="ml-1 text-green-600 border-green-600">Configured</Badge>
            ) : (
              <Badge variant="outline" className="ml-1 text-amber-600 border-amber-600">Not Configured</Badge>
            )}
          </p>
          {oauthAuthorized && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive h-7"
              onClick={handleRevokePat}
              disabled={oauthRevoke.isPending}
            >
              Remove
            </Button>
          )}
        </div>
        {!oauthAuthorized && (
          <p className="text-muted-foreground mt-1">
            A personal access token with <code className="text-xs bg-muted px-1 py-0.5 rounded">read:packages</code> scope
            is needed to list GHCR container packages (GitHub App tokens cannot access them).
          </p>
        )}
        {oauthAuthorized && (
          <p className="text-muted-foreground mt-1">
            Personal access token is configured. GHCR container packages are accessible.
          </p>
        )}
      </div>

      {!oauthAuthorized && !showPatInput && (
        <div className="mt-3 flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              window.open(
                "https://github.com/settings/tokens/new?description=mini-infra+package+access&scopes=read:packages",
                "_blank",
              );
              setShowPatInput(true);
            }}
          >
            <IconBrandGithub className="mr-2 h-4 w-4" />
            Generate Token on GitHub
          </Button>
        </div>
      )}

      {!oauthAuthorized && showPatInput && (
        <TokenInput
          placeholder="ghp_..."
          promptText="Generate the token on GitHub, then paste it below:"
          value={patInput}
          onChange={setPatInput}
          onSave={handleSavePat}
          onCancel={() => { setShowPatInput(false); setPatInput(""); }}
          isSaving={savePat.isPending}
        />
      )}
    </div>
  );
}
