import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconKey,
  IconLoader2,
  IconRefresh,
  IconShield,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SecuritySecrets {
  session_secret: string;
  api_key_secret: string;
  session_secret_id: string | null;
  api_key_secret_id: string | null;
}

interface RegenerateResponse {
  message: string;
  warning: string;
}

export default function SecuritySettingsPage() {
  const queryClient = useQueryClient();
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    secretType: "session" | "apiKey" | null;
    title: string;
    description: string;
  }>({
    isOpen: false,
    secretType: null,
    title: "",
    description: "",
  });

  // Fetch security secrets
  const {
    data: secrets,
    isLoading,
    error,
  } = useQuery<SecuritySecrets>({
    queryKey: ["security-secrets"],
    queryFn: async () => {
      const res = await fetch("/api/settings/security");
      if (!res.ok) {
        throw new Error("Failed to fetch security secrets");
      }
      return res.json();
    },
  });

  // Regenerate secret mutation
  const regenerateMutation = useMutation({
    mutationFn: async (secretType: "session" | "apiKey") => {
      const res = await fetch("/api/settings/security/regenerate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ secret: secretType }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to regenerate secret");
      }

      return res.json() as Promise<RegenerateResponse>;
    },
    onSuccess: (data) => {
      toastWithCopy.success(data.message, {
        title: "Success",
      });

      // Show warning toast
      setTimeout(() => {
        toastWithCopy.warning(data.warning, {
          title: "Warning",
        });
      }, 1000);

      // Refresh the secrets
      queryClient.invalidateQueries({ queryKey: ["security-secrets"] });
    },
    onError: (error: Error) => {
      toastWithCopy.error(error.message, {
        title: "Error",
      });
    },
  });

  const handleRegenerateClick = (secretType: "session" | "apiKey") => {
    const isSession = secretType === "session";
    setConfirmDialog({
      isOpen: true,
      secretType,
      title: `Regenerate ${isSession ? "Session" : "API Key"} Secret?`,
      description: isSession
        ? "This will invalidate all active user sessions. All users will need to log in again. Are you sure you want to continue?"
        : "This will break all existing API keys. API key hashes are based on this secret. Users will need to create new API keys. Are you sure you want to continue?",
    });
  };

  const handleConfirmRegenerate = () => {
    if (confirmDialog.secretType) {
      regenerateMutation.mutate(confirmDialog.secretType);
    }
    setConfirmDialog({ isOpen: false, secretType: null, title: "", description: "" });
  };

  const handleCancelRegenerate = () => {
    setConfirmDialog({ isOpen: false, secretType: null, title: "", description: "" });
  };

  if (isLoading) {
    return (
      <div className="container mx-auto max-w-4xl space-y-6 py-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>

        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto max-w-4xl space-y-6 py-8">
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load security settings. Please try again later.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-4xl space-y-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <IconShield className="h-6 w-6" />
            <h1 className="text-2xl font-bold tracking-tight">
              Security Settings
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Manage security secrets for authentication and encryption
          </p>
        </div>

        <Button variant="outline" asChild>
          <Link to="/settings">
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back to Settings
          </Link>
        </Button>
      </div>

      {/* Warning Alert */}
      <Alert>
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          <strong>Important:</strong> These secrets are used system-wide for
          authentication and encryption. Regenerating them will have immediate
          effects on all users and services.
        </AlertDescription>
      </Alert>

      {/* Security Secrets Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconKey className="h-5 w-5" />
            Security Secrets
          </CardTitle>
          <CardDescription>
            View and regenerate security secrets. Secrets are masked for security.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Session Secret */}
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <h3 className="font-semibold">Session Secret</h3>
                <p className="text-sm text-muted-foreground">
                  Used to sign and verify JWT authentication tokens
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRegenerateClick("session")}
                disabled={regenerateMutation.isPending}
              >
                {regenerateMutation.isPending ? (
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <IconRefresh className="h-4 w-4 mr-2" />
                )}
                Regenerate
              </Button>
            </div>
            <div className="rounded bg-muted p-3 font-mono text-sm">
              {secrets?.session_secret || "••••••••"}
            </div>
            <p className="text-xs text-muted-foreground">
              ⚠️ Regenerating will invalidate all active user sessions
            </p>
          </div>

          {/* API Key Secret */}
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <h3 className="font-semibold">API Key Secret</h3>
                <p className="text-sm text-muted-foreground">
                  Used to hash API keys and encrypt sensitive configuration data
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRegenerateClick("apiKey")}
                disabled={regenerateMutation.isPending}
              >
                {regenerateMutation.isPending ? (
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <IconRefresh className="h-4 w-4 mr-2" />
                )}
                Regenerate
              </Button>
            </div>
            <div className="rounded bg-muted p-3 font-mono text-sm">
              {secrets?.api_key_secret || "••••••••"}
            </div>
            <p className="text-xs text-muted-foreground">
              ⚠️ Regenerating will break all existing API keys
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <Dialog open={confirmDialog.isOpen} onOpenChange={(open) => {
        if (!open) handleCancelRegenerate();
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmDialog.title}</DialogTitle>
            <DialogDescription>{confirmDialog.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelRegenerate}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmRegenerate}
              disabled={regenerateMutation.isPending}
            >
              {regenerateMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
