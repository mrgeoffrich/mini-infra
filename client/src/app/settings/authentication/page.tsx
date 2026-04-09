import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { IconAlertCircle, IconLoader2 } from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import type { AuthSettingsInfo, UpdateAuthSettingsRequest } from "@mini-infra/types";

export default function AuthenticationSettingsPage() {
  const queryClient = useQueryClient();

  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  const {
    data: settings,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["auth-settings"],
    queryFn: async () => {
      const response = await fetch("/api/auth-settings", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch auth settings");
      const data = await response.json();
      return data.data as AuthSettingsInfo;
    },
  });

  // Sync form state when settings load
  useEffect(() => {
    if (settings) {
      setGoogleEnabled(settings.googleOAuthEnabled);
      setClientId(settings.googleClientId || "");
      setClientSecret("");
      setIsDirty(false);
    }
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: async (body: UpdateAuthSettingsRequest) => {
      const response = await fetch("/api/auth-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Failed to update settings");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth-settings"] });
      queryClient.invalidateQueries({ queryKey: ["setup-status"] });
      setIsDirty(false);
      toastWithCopy.success("Authentication settings saved");
    },
  });

  const handleSave = () => {
    const update: UpdateAuthSettingsRequest = {
      googleOAuthEnabled: googleEnabled,
      googleClientId: clientId || undefined,
    };
    // Only send client secret if it was changed (non-empty)
    if (clientSecret) {
      update.googleClientSecret = clientSecret;
    }
    updateMutation.mutate(update);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load authentication settings</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Authentication Settings</CardTitle>
          <CardDescription>
            Configure authentication methods for Mini Infra. Password
            authentication is always enabled.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {updateMutation.error && (
            <Alert variant="destructive">
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>
                {updateMutation.error.message}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label className="text-base">Google OAuth</Label>
              <p className="text-sm text-muted-foreground">
                Allow users to sign in with their Google account
              </p>
            </div>
            <Switch
              checked={googleEnabled}
              onCheckedChange={(checked) => {
                setGoogleEnabled(checked);
                setIsDirty(true);
              }}
            />
          </div>

          {googleEnabled && (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="space-y-2">
                <Label htmlFor="clientId">Google Client ID</Label>
                <Input
                  id="clientId"
                  type="text"
                  value={clientId}
                  onChange={(e) => {
                    setClientId(e.target.value);
                    setIsDirty(true);
                  }}
                  placeholder="Enter Google OAuth Client ID"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="clientSecret">Google Client Secret</Label>
                <Input
                  id="clientSecret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => {
                    setClientSecret(e.target.value);
                    setIsDirty(true);
                  }}
                  placeholder={
                    settings?.hasGoogleClientSecret
                      ? "Leave blank to keep existing secret"
                      : "Enter Google OAuth Client Secret"
                  }
                />
                {settings?.hasGoogleClientSecret && (
                  <p className="text-xs text-muted-foreground">
                    A client secret is already configured. Leave blank to keep
                    it unchanged.
                  </p>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Create OAuth credentials in the{" "}
                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Google Cloud Console
                </a>
                . Set the authorized redirect URI to{" "}
                <code className="text-xs bg-muted px-1 rounded">
                  {window.location.origin}/auth/google/callback
                </code>
              </p>
            </div>
          )}

          <Button
            onClick={handleSave}
            disabled={!isDirty || updateMutation.isPending}
          >
            {updateMutation.isPending ? (
              <>
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
