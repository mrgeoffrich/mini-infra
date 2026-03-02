import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { StatusBadge } from "@/components/connectivity-status";
import { useConnectivityStatus } from "@/hooks/use-settings";
import {
  useTestGitHubApp,
  useCreateGhcrCredential,
  useDeleteGitHubApp,
} from "@/hooks/use-github-app";
import {
  IconBrandGithub,
  IconLoader2,
  IconPackage,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import type { ConnectivityStatusType, GitHubAgentAccessLevel } from "@mini-infra/types";
import { PackageAccessSection } from "./package-access-section";
import { AgentAccessSection } from "./agent-access-section";

interface ConnectedStatusCardProps {
  appSlug: string | null;
  owner: string | null;
  appId: string | null;
  oauthAuthorized: boolean;
  agentAccessConfigured: boolean;
  agentAccessLevel: GitHubAgentAccessLevel | null;
}

export function ConnectedStatusCard({
  appSlug,
  owner,
  appId,
  oauthAuthorized,
  agentAccessConfigured,
  agentAccessLevel,
}: ConnectedStatusCardProps) {
  const testConnection = useTestGitHubApp();
  const createGhcrCredential = useCreateGhcrCredential();
  const deleteApp = useDeleteGitHubApp();

  // Fetch connectivity status
  const { data: connectivityData } = useConnectivityStatus({
    filters: { service: "github-app" },
    limit: 10,
    refetchInterval: 30000,
  });

  const githubConnectivity = connectivityData?.data?.[0];

  const handleTest = () => {
    testConnection.mutate(undefined, {
      onSuccess: (data) => {
        if (data.isValid) {
          toast.success(
            `Connection successful${data.authenticatedAs ? ` as ${data.authenticatedAs}` : ""} (${data.responseTimeMs}ms)`,
          );
        } else {
          toast.error(`Connection test failed: ${data.message}`);
        }
      },
      onError: (error) => {
        toast.error(`Connection test failed: ${error.message}`);
      },
    });
  };

  const handleRefreshToken = () => {
    createGhcrCredential.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(data.message || "GHCR token refreshed successfully");
      },
      onError: (error) => {
        toast.error(`Failed to refresh GHCR token: ${error.message}`);
      },
    });
  };

  const handleDisconnect = () => {
    deleteApp.mutate(undefined, {
      onSuccess: () => {
        toast.success("GitHub App disconnected successfully");
      },
      onError: (error) => {
        toast.error(`Failed to disconnect: ${error.message}`);
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <IconBrandGithub className="h-5 w-5" />
              GitHub App Connected
            </CardTitle>
            <CardDescription>
              Your GitHub App is configured and active
            </CardDescription>
          </div>
          {githubConnectivity && (
            <StatusBadge
              status={
                githubConnectivity.status as ConnectivityStatusType
              }
              responseTimeMs={githubConnectivity.responseTimeMs}
              size="sm"
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">App Name</span>
            <p className="font-medium">{appSlug || "N/A"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Connected Account</span>
            <p className="font-medium">{owner || "N/A"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">App ID</span>
            <p className="font-medium">{appId || "N/A"}</p>
          </div>
        </div>

        <PackageAccessSection oauthAuthorized={oauthAuthorized} />
        <AgentAccessSection
          agentAccessConfigured={agentAccessConfigured}
          agentAccessLevel={agentAccessLevel}
        />
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={testConnection.isPending}
        >
          {testConnection.isPending ? (
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <IconRefresh className="mr-2 h-4 w-4" />
          )}
          Test Connection
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefreshToken}
          disabled={createGhcrCredential.isPending}
        >
          {createGhcrCredential.isPending ? (
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <IconPackage className="mr-2 h-4 w-4" />
          )}
          Refresh GHCR Token
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteApp.isPending}
            >
              {deleteApp.isPending ? (
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <IconTrash className="mr-2 h-4 w-4" />
              )}
              Disconnect
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect GitHub App?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove the GitHub App configuration and all associated
                credentials. You will need to set up the connection again to
                access GitHub packages, repositories, and actions.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDisconnect}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}
