import { useState } from "react";
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
  app_secret: string;
  app_secret_id: string | null;
}

interface RegenerateResponse {
  message: string;
  warning: string;
}

export default function SecuritySettingsPage() {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/security/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to regenerate secret");
      }

      return res.json() as Promise<RegenerateResponse>;
    },
    onSuccess: (data) => {
      toastWithCopy.success(data.message);
      setTimeout(() => {
        toastWithCopy.warning(data.warning);
      }, 1000);
      queryClient.invalidateQueries({ queryKey: ["security-secrets"] });
    },
    onError: (error: Error) => {
      toastWithCopy.error(error.message);
    },
  });

  const handleConfirmRegenerate = () => {
    regenerateMutation.mutate();
    setConfirmOpen(false);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto max-w-4xl space-y-6 py-8">
        <div className="space-y-1">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent>
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
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <IconShield className="h-6 w-6" />
          <h1 className="text-2xl font-bold tracking-tight">
            Security Settings
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage the application secret used for authentication and encryption
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconKey className="h-5 w-5" />
            Application Secret
          </CardTitle>
          <CardDescription>
            A single secret used for JWT signing, API key hashing, and
            credential encryption. Auto-generated on first boot.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <h3 className="font-semibold">App Secret</h3>
                <p className="text-sm text-muted-foreground">
                  Used for all authentication and encryption operations
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmOpen(true)}
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
              {secrets?.app_secret || "••••••••"}
            </div>
            <p className="text-xs text-muted-foreground">
              Regenerating will invalidate all active sessions and break all
              existing API keys. Users will need to log in again and create new
              API keys.
            </p>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate App Secret?</DialogTitle>
            <DialogDescription>
              This will invalidate all active user sessions and break all
              existing API keys. All users will need to log in again and create
              new API keys. Are you sure you want to continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
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
