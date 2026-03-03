import { useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconCircleX, IconLoader2 } from "@tabler/icons-react";
import { toast } from "sonner";
import { useGitHubAppSetupComplete } from "@/hooks/use-github-app";

interface SetupCompletionProps {
  code: string;
  onComplete: () => void;
}

export function SetupCompletion({ code, onComplete }: SetupCompletionProps) {
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
