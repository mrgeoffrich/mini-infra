import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconBrandGithub, IconKey, IconRefresh, IconLoader2 } from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useGitHubSavePackagePat,
  useGitHubOAuthRevoke,
  useGitHubSyncRegistry,
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
  const syncRegistry = useGitHubSyncRegistry();
  const [patInput, setPatInput] = useState("");
  const [showPatInput, setShowPatInput] = useState(false);

  const handleSavePat = () => {
    if (!patInput.trim()) return;
    savePat.mutate(
      { token: patInput.trim() },
      {
        onSuccess: (data) => {
          const msg = data.registryCredentialCreated
            ? `Token saved and GHCR registry credentials configured for ${data.githubUsername}.`
            : "Token saved! GHCR packages should now be visible.";
          toast.success(msg);
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

  const handleSyncRegistry = () => {
    syncRegistry.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(data.message);
      },
      onError: (error) => {
        toast.error(`Failed to sync: ${error.message}`);
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
          <div className="flex items-center gap-1">
            {oauthAuthorized && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={handleSyncRegistry}
                  disabled={syncRegistry.isPending}
                >
                  {syncRegistry.isPending ? (
                    <IconLoader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <IconRefresh className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Sync to Registry
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive h-7"
                  onClick={handleRevokePat}
                  disabled={oauthRevoke.isPending}
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
        {!oauthAuthorized ? (
          <p className="text-muted-foreground mt-1">
            Create a classic personal access token with <code className="text-xs bg-muted px-1 py-0.5 rounded">read:packages</code> and{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">write:packages</code> scopes.
            This will configure both package listing and{" "}
            <Link to="/settings/registry-credentials" className="text-primary underline underline-offset-4 hover:text-primary/80">
              GHCR registry credentials
            </Link>{" "}
            for pulling images.
          </p>
        ) : (
          <p className="text-muted-foreground mt-1">
            Personal access token is configured for package listing and{" "}
            <Link to="/settings/registry-credentials" className="text-primary underline underline-offset-4 hover:text-primary/80">
              GHCR registry credentials
            </Link>.
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
                "https://github.com/settings/tokens/new?description=mini-infra+ghcr+access&scopes=read:packages,write:packages",
                "_blank",
              );
              setShowPatInput(true);
            }}
          >
            <IconBrandGithub className="mr-2 h-4 w-4" />
            Generate Classic Token on GitHub
          </Button>
        </div>
      )}

      {!oauthAuthorized && showPatInput && (
        <TokenInput
          placeholder="ghp_..."
          promptText="Generate the classic token on GitHub, then paste it below:"
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
