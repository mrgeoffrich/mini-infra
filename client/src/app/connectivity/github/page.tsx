import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  useGitHubAppSettings,
  useGitHubAppSetupComplete,
  useRefreshGitHubAppInstallation,
  useTestGitHubApp,
  useDeleteGitHubApp,
  useCreateGhcrCredential,
  useGitHubAppPackages,
  useGitHubAppRepositories,
  useGitHubAppActionRuns,
} from "@/hooks/use-github-app";
import {
  IconBrandGithub,
  IconCircleX,
  IconAlertCircle,
  IconLoader2,
  IconShield,
  IconPackage,
  IconGitBranch,
  IconPlayerPlay,
  IconExternalLink,
  IconRefresh,
  IconTrash,
  IconPlugConnected,
  IconLock,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import type {
  GitHubAppPackage,
  GitHubAppRepository,
  GitHubAppActionsRun,
  ConnectivityStatusType,
} from "@mini-infra/types";

// ====================
// Helper Functions
// ====================

function formatDate(dateString: string): string {
  try {
    return formatDistanceToNow(new Date(dateString), { addSuffix: true });
  } catch {
    return "Unknown";
  }
}

function getRunStatusColor(
  status: string,
  conclusion: string | null,
): { className: string; label: string } {
  if (status === "completed") {
    switch (conclusion) {
      case "success":
        return {
          className:
            "bg-green-100 text-green-800 border-green-200 hover:bg-green-100",
          label: "Success",
        };
      case "failure":
        return {
          className:
            "bg-red-100 text-red-800 border-red-200 hover:bg-red-100",
          label: "Failure",
        };
      case "cancelled":
        return {
          className:
            "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-100",
          label: "Cancelled",
        };
      case "skipped":
        return {
          className:
            "bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-100",
          label: "Skipped",
        };
      case "timed_out":
        return {
          className:
            "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-100",
          label: "Timed Out",
        };
      default:
        return {
          className:
            "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-100",
          label: conclusion || "Unknown",
        };
    }
  }

  if (status === "in_progress") {
    return {
      className:
        "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-100",
      label: "In Progress",
    };
  }

  if (status === "queued") {
    return {
      className:
        "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100",
      label: "Queued",
    };
  }

  if (status === "waiting") {
    return {
      className:
        "bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-100",
      label: "Waiting",
    };
  }

  return {
    className:
      "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-100",
    label: status,
  };
}

// ====================
// Setup Flow Component
// ====================

function SetupCard() {
  const formRef = useRef<HTMLFormElement>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  const handleConnect = async () => {
    setIsRedirecting(true);
    try {
      const callbackUrl =
        window.location.origin + "/connectivity-github";

      const response = await fetch("/api/settings/github-app/manifest", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callbackUrl }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to generate manifest",
        }));
        throw new Error(errorData.message || "Failed to generate manifest");
      }

      const result = await response.json();
      const manifest = result.data;

      // Create a hidden form and submit to GitHub
      const form = formRef.current;
      if (form) {
        const input = form.querySelector(
          'input[name="manifest"]',
        ) as HTMLInputElement;
        input.value = JSON.stringify(manifest);
        form.submit();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start setup";
      toast.error(message);
      setIsRedirecting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconPlugConnected className="h-5 w-5" />
          Connect to GitHub
        </CardTitle>
        <CardDescription>
          Create a GitHub App to securely connect your GitHub account. This will
          redirect you to GitHub where you can review and approve the
          permissions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-2">
              Permissions that will be requested:
            </h4>
            <ul className="space-y-2">
              <li className="flex items-center gap-2 text-sm">
                <IconPackage className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Packages</span>
                <Badge variant="secondary">read</Badge>
              </li>
              <li className="flex items-center gap-2 text-sm">
                <IconPlayerPlay className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Actions</span>
                <Badge variant="secondary">read</Badge>
              </li>
              <li className="flex items-center gap-2 text-sm">
                <IconGitBranch className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Contents</span>
                <Badge variant="secondary">read</Badge>
              </li>
              <li className="flex items-center gap-2 text-sm">
                <IconShield className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Metadata</span>
                <Badge variant="secondary">read</Badge>
              </li>
            </ul>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        {/* Hidden form for GitHub manifest flow */}
        <form
          ref={formRef}
          action="https://github.com/settings/apps/new"
          method="post"
          style={{ display: "none" }}
        >
          <input type="hidden" name="manifest" value="" />
        </form>
        <Button onClick={handleConnect} disabled={isRedirecting}>
          {isRedirecting ? (
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <IconBrandGithub className="mr-2 h-4 w-4" />
          )}
          {isRedirecting ? "Redirecting to GitHub..." : "Connect to GitHub"}
        </Button>
      </CardFooter>
    </Card>
  );
}

// ====================
// Setup Completion Component
// ====================

function SetupCompletion({
  code,
  onComplete,
}: {
  code: string;
  onComplete: () => void;
}) {
  const setupComplete = useGitHubAppSetupComplete();
  const hasAttemptedRef = useRef(false);

  useEffect(() => {
    // Guard against React strict mode double-mounting.
    // The GitHub manifest code is single-use, so we must only call once.
    if (code && !hasAttemptedRef.current) {
      hasAttemptedRef.current = true;
      setupComplete.mutate(
        { code },
        {
          onSuccess: (data) => {
            toast.success(
              data.message || "GitHub App connected successfully!",
            );
            onComplete();
          },
          onError: (error) => {
            toast.error(`Setup failed: ${error.message}`);
          },
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (setupComplete.isError) {
    return (
      <Alert variant="destructive">
        <IconCircleX className="h-4 w-4" />
        <AlertDescription>
          Failed to complete GitHub App setup: {setupComplete.error.message}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-center py-12">
        <div className="text-center space-y-3">
          <IconLoader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
          <p className="text-lg font-medium">
            Completing GitHub App setup...
          </p>
          <p className="text-sm text-muted-foreground">
            Please wait while we finalize the connection with GitHub.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ====================
// Needs Installation Card
// ====================

function NeedsInstallationCard({
  appSlug,
  installUrl,
}: {
  appSlug: string | null;
  installUrl: string | null;
}) {
  const refreshInstallation = useRefreshGitHubAppInstallation();
  const deleteApp = useDeleteGitHubApp();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconAlertCircle className="h-5 w-5 text-amber-500" />
          App Created — Installation Required
        </CardTitle>
        <CardDescription>
          Your GitHub App <strong>{appSlug}</strong> has been created, but it
          still needs to be installed on your GitHub account or organization
          to grant access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-4">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Click the button below to install the app on GitHub. After
            installing, come back here and click &quot;Check Installation&quot;.
          </p>
        </div>
      </CardContent>
      <CardFooter className="flex gap-2">
        {installUrl && (
          <Button asChild>
            <a href={installUrl} target="_blank" rel="noopener noreferrer">
              <IconBrandGithub className="h-4 w-4 mr-2" />
              Install on GitHub
              <IconExternalLink className="h-3 w-3 ml-1" />
            </a>
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() =>
            refreshInstallation.mutate(undefined, {
              onSuccess: (data) => {
                if (data.found) {
                  toast.success("Installation found! GitHub App is now connected.");
                } else {
                  toast.error(
                    "No installation found yet. Please install the app on GitHub first.",
                  );
                }
              },
              onError: (error) => {
                toast.error(`Failed to check: ${error.message}`);
              },
            })
          }
          disabled={refreshInstallation.isPending}
        >
          {refreshInstallation.isPending ? (
            <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <IconRefresh className="h-4 w-4 mr-2" />
          )}
          Check Installation
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive ml-auto">
              <IconTrash className="h-4 w-4 mr-1" />
              Remove App
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove GitHub App?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove the stored app credentials. You will need to
                create a new GitHub App to reconnect. The app itself will remain
                on GitHub and should be deleted manually from your GitHub settings.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  deleteApp.mutate(undefined, {
                    onSuccess: () => toast.success("GitHub App removed"),
                    onError: (e) => toast.error(`Failed: ${e.message}`),
                  })
                }
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}

// ====================
// Connected Status Card
// ====================

function ConnectedStatusCard({
  appSlug,
  owner,
  appId,
}: {
  appSlug: string | null;
  owner: string | null;
  appId: string | null;
}) {
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

// ====================
// Packages Tab
// ====================

function PackagesTab({ isConnected }: { isConnected: boolean }) {
  const {
    data: packages,
    isLoading,
    error,
  } = useGitHubAppPackages(isConnected);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load packages: {error.message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!packages || packages.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <IconPackage className="h-12 w-12 mx-auto mb-3 opacity-40" />
        <p>No packages found</p>
        <p className="text-sm mt-1">
          Packages will appear here once published to your GitHub account.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Visibility</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {packages.map((pkg: GitHubAppPackage) => (
          <TableRow key={pkg.id}>
            <TableCell className="font-medium">{pkg.name}</TableCell>
            <TableCell>
              <Badge variant="secondary">{pkg.packageType}</Badge>
            </TableCell>
            <TableCell>
              {pkg.visibility === "private" ? (
                <Badge variant="outline" className="gap-1">
                  <IconLock className="h-3 w-3" />
                  Private
                </Badge>
              ) : (
                <Badge variant="secondary">{pkg.visibility}</Badge>
              )}
            </TableCell>
            <TableCell>{pkg.owner}</TableCell>
            <TableCell className="text-muted-foreground">
              {formatDate(pkg.updatedAt)}
            </TableCell>
            <TableCell>
              <a
                href={pkg.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
              >
                <IconExternalLink className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ====================
// Repositories Tab
// ====================

function RepositoriesTab({ isConnected }: { isConnected: boolean }) {
  const {
    data: repos,
    isLoading,
    error,
  } = useGitHubAppRepositories(isConnected);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load repositories: {error.message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <IconGitBranch className="h-12 w-12 mx-auto mb-3 opacity-40" />
        <p>No repositories found</p>
        <p className="text-sm mt-1">
          Repositories accessible by the GitHub App will appear here.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Language</TableHead>
          <TableHead>Visibility</TableHead>
          <TableHead>Default Branch</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {repos.map((repo: GitHubAppRepository) => (
          <TableRow key={repo.id}>
            <TableCell className="font-medium">{repo.name}</TableCell>
            <TableCell
              className="max-w-[200px] truncate text-muted-foreground"
              title={repo.description || undefined}
            >
              {repo.description || "-"}
            </TableCell>
            <TableCell>
              {repo.language ? (
                <Badge variant="secondary">{repo.language}</Badge>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </TableCell>
            <TableCell>
              {repo.private ? (
                <Badge variant="outline" className="gap-1">
                  <IconLock className="h-3 w-3" />
                  Private
                </Badge>
              ) : (
                <Badge variant="secondary">Public</Badge>
              )}
            </TableCell>
            <TableCell>
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                {repo.defaultBranch}
              </code>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDate(repo.updatedAt)}
            </TableCell>
            <TableCell>
              <a
                href={repo.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
              >
                <IconExternalLink className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ====================
// Actions Tab
// ====================

function ActionsTab({
  isConnected,
  repositories,
}: {
  isConnected: boolean;
  repositories?: GitHubAppRepository[];
}) {
  const [selectedRepo, setSelectedRepo] = useState<string>("");

  // Parse owner/repo from the selected full name
  const [repoOwner, repoName] = selectedRepo
    ? selectedRepo.split("/")
    : ["", ""];

  const {
    data: runs,
    isLoading,
    error,
  } = useGitHubAppActionRuns(
    repoOwner,
    repoName,
    isConnected && !!selectedRepo,
  );

  // Filter repos that have actions enabled
  const actionsRepos = repositories?.filter((r) => r.hasActions) || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Repository:</label>
        <Select value={selectedRepo} onValueChange={setSelectedRepo}>
          <SelectTrigger className="w-[300px]">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {actionsRepos.length === 0 && repositories && repositories.length > 0 ? (
              // Show all repos if none have hasActions flag
              repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </SelectItem>
              ))
            ) : actionsRepos.length > 0 ? (
              actionsRepos.map((repo) => (
                <SelectItem key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </SelectItem>
              ))
            ) : (
              <SelectItem value="__none__" disabled>
                No repositories available
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      {!selectedRepo && (
        <div className="text-center py-8 text-muted-foreground">
          <IconPlayerPlay className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p>Select a repository to view workflow runs</p>
        </div>
      )}

      {selectedRepo && isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {selectedRepo && error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load action runs: {error.message}
          </AlertDescription>
        </Alert>
      )}

      {selectedRepo && !isLoading && !error && runs && runs.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <IconPlayerPlay className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p>No workflow runs found for this repository</p>
        </div>
      )}

      {selectedRepo && !isLoading && !error && runs && runs.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Run #</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run: GitHubAppActionsRun) => {
              const statusInfo = getRunStatusColor(
                run.status,
                run.conclusion,
              );
              return (
                <TableRow key={run.id}>
                  <TableCell className="font-medium">
                    {run.workflowName}
                  </TableCell>
                  <TableCell>
                    <Badge className={statusInfo.className}>
                      {statusInfo.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {run.headBranch}
                    </code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    #{run.runNumber}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{run.event}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(run.createdAt)}
                  </TableCell>
                  <TableCell>
                    <a
                      href={run.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex"
                    >
                      <IconExternalLink className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
                    </a>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ====================
// Main Page Component
// ====================

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
        {!settingsLoading && !isConnected && !needsInstallation && !code && <SetupCard />}

        {/* Connected State */}
        {!settingsLoading && isConnected && (
          <div className="space-y-6">
            <ConnectedStatusCard
              appSlug={settings?.appSlug ?? null}
              owner={settings?.owner ?? null}
              appId={settings?.appId ?? null}
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
