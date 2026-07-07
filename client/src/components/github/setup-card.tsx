import { useState, useRef } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  IconBrandGithub,
  IconLoader2,
  IconShield,
  IconPackage,
  IconGitBranch,
  IconPlayerPlay,
  IconPlugConnected,
} from "@tabler/icons-react";
import { ApiRoute } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";
import { toastApiError } from "@/lib/errors";

export function SetupCard() {
  const formRef = useRef<HTMLFormElement>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  const handleConnect = async () => {
    setIsRedirecting(true);
    try {
      const callbackUrl =
        window.location.origin + "/connectivity-github";

      // Server returns the raw GitHub App manifest object (no shared type —
      // it's typed `object` server-side too, see `github-app-setup.ts`).
      const manifest = await apiFetch<Record<string, unknown>>(
        ApiRoute.settings.githubAppManifest(),
        {
          method: "POST",
          body: { callbackUrl },
          correlationIdPrefix: "github-app-setup",
        },
      );

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
      // Manual apiFetch call, not a useMutation — the global
      // MutationCache.onError (client/src/lib/query-client.ts) never sees
      // it, so this is the one place responsible for surfacing the error.
      // Use the shared presentation layer instead of raw error.message so
      // the toast benefits from the same code/resource-aware titling as
      // every mutation-driven toast.
      toastApiError(error, { title: "Failed to start setup" });
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
