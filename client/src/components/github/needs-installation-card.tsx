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
import {
  IconAlertCircle,
  IconBrandGithub,
  IconExternalLink,
  IconLoader2,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useRefreshGitHubAppInstallation,
  useDeleteGitHubApp,
} from "@/hooks/use-github-app";

interface NeedsInstallationCardProps {
  appSlug: string | null;
  installUrl: string | null;
}

export function NeedsInstallationCard({
  appSlug,
  installUrl,
}: NeedsInstallationCardProps) {
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
