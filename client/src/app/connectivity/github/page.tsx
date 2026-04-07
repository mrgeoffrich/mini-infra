import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  IconBrandGithub,
  IconAlertCircle,
  IconPackage,
  IconGitBranch,
  IconPlayerPlay,
} from "@tabler/icons-react";
import {
  useGitHubAppSettings,
  useGitHubAppRepositories,
} from "@/hooks/use-github-app";
import { SetupCard } from "@/components/github/setup-card";
import { SetupCompletion } from "@/components/github/setup-completion";
import { NeedsInstallationCard } from "@/components/github/needs-installation-card";
import { ConnectedStatusCard } from "@/components/github/connected-status-card";
import { PackagesTab } from "@/components/github/packages-tab";
import { RepositoriesTab } from "@/components/github/repositories-tab";
import { ActionsTab } from "@/components/github/actions-tab";

export default function GitHubConnectivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const code = searchParams.get("code");

  const {
    data: settings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useGitHubAppSettings();

  const { data: repos } = useGitHubAppRepositories(
    settings?.isConfigured === true,
  );

  const isConnected = settings?.isConfigured === true;
  const needsInstallation = settings?.needsInstallation === true;

  const handleSetupComplete = useCallback(() => {
    // Clear the code parameter from the URL
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("code");
      return next;
    });
  }, [setSearchParams]);

  // Error state
  if (settingsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
              <IconBrandGithub className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">GitHub</h1>
              <p className="text-muted-foreground">
                Connect your GitHub account to browse packages, repositories,
                and actions
              </p>
            </div>
          </div>

          <Alert variant="destructive" className="mt-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load GitHub App settings: {settingsError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Page Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
            <IconBrandGithub className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">GitHub</h1>
            <p className="text-muted-foreground">
              Connect your GitHub account to browse packages, repositories, and
              actions
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-5xl">
        {/* Loading State */}
        {settingsLoading && (
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
          </div>
        )}

        {/* Setup Completion (when returning from GitHub with code) */}
        {!settingsLoading && code && !isConnected && !needsInstallation && (
          <SetupCompletion code={code} onComplete={handleSetupComplete} />
        )}

        {/* Needs Installation (app created but not installed) */}
        {!settingsLoading && needsInstallation && (
          <NeedsInstallationCard
            appSlug={settings?.appSlug ?? null}
            installUrl={settings?.installUrl ?? null}
          />
        )}

        {/* Setup Flow (when not configured and no code) */}
        {!settingsLoading && !isConnected && !needsInstallation && !code && <div data-tour="github-setup-card"><SetupCard /></div>}

        {/* Connected State */}
        {!settingsLoading && isConnected && (
          <div className="space-y-6">
            <ConnectedStatusCard
              appSlug={settings?.appSlug ?? null}
              owner={settings?.owner ?? null}
              appId={settings?.appId ?? null}
              oauthAuthorized={settings?.oauth?.isAuthorized === true}
              agentAccessConfigured={settings?.agentAccess?.isConfigured === true}
              agentAccessLevel={settings?.agentAccess?.accessLevel ?? null}
            />

            {/* Resource Tabs */}
            <Tabs defaultValue="packages">
              <TabsList>
                <TabsTrigger value="packages" className="gap-1.5">
                  <IconPackage className="h-4 w-4" />
                  Packages
                </TabsTrigger>
                <TabsTrigger value="repositories" className="gap-1.5">
                  <IconGitBranch className="h-4 w-4" />
                  Repositories
                </TabsTrigger>
                <TabsTrigger value="actions" className="gap-1.5">
                  <IconPlayerPlay className="h-4 w-4" />
                  Actions
                </TabsTrigger>
              </TabsList>

              <TabsContent value="packages">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Packages</CardTitle>
                    <CardDescription>
                      Container images and packages published to your GitHub
                      account
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <PackagesTab isConnected={isConnected} />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="repositories">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Repositories</CardTitle>
                    <CardDescription>
                      Repositories accessible by the GitHub App installation
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <RepositoriesTab isConnected={isConnected} />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="actions">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      GitHub Actions Runs
                    </CardTitle>
                    <CardDescription>
                      View recent workflow runs for your repositories
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ActionsTab
                      isConnected={isConnected}
                      repositories={repos}
                    />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
}
