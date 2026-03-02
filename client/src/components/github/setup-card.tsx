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
import { toast } from "sonner";

export function SetupCard() {
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
