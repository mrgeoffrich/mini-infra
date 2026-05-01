import React, { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  IconBrandGoogleDrive,
  IconCircleCheck,
  IconCircleX,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconShield,
  IconUnlink,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useDisconnectGoogleDrive,
  useGoogleDriveProviderConfig,
  useStartGoogleDriveOAuth,
  useUpdateGoogleDriveProviderConfig,
} from "@/hooks/use-storage-settings";

const driveSettingsSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client secret is required"),
});

type DriveSettingsFormData = z.infer<typeof driveSettingsSchema>;

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  redirect_uri_mismatch:
    "Google rejected the redirect URI. Add the exact URL Mini Infra uses to your OAuth client's Authorised redirect URIs.",
  client_credentials_missing:
    "Client ID and secret were missing during the callback. Save them and try again.",
  exchange_failed:
    "Google rejected the authorization code. The code may have expired or been used twice.",
  missing_code: "Google didn't return an authorization code.",
  missing_state: "OAuth state parameter was missing.",
  malformed_state: "OAuth state parameter is malformed.",
  bad_signature: "OAuth state failed signature verification.",
  stale_state: "OAuth state expired (>10 minutes). Please try again.",
  invalid_state: "OAuth state could not be verified.",
  access_denied: "You denied the consent screen — Google Drive was not connected.",
};

export interface GoogleDriveProviderConfigProps {
  className?: string;
}

export const GoogleDriveProviderConfig = React.memo(
  function GoogleDriveProviderConfig({
    className,
  }: GoogleDriveProviderConfigProps) {
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const [showSecret, setShowSecret] = useState(false);

    const { data: providerConfig, isLoading: configLoading } =
      useGoogleDriveProviderConfig();
    const updateConfig = useUpdateGoogleDriveProviderConfig();
    const disconnect = useDisconnectGoogleDrive();
    const { authorizeUrl } = useStartGoogleDriveOAuth();

    const form = useForm<DriveSettingsFormData>({
      resolver: zodResolver(driveSettingsSchema),
      defaultValues: { clientId: "", clientSecret: "" },
      mode: "onChange",
    });

    // Pre-populate clientId once the provider config arrives — clientSecret
    // is never echoed back from the server.
    useEffect(() => {
      if (providerConfig?.clientId && !form.formState.isDirty) {
        form.reset({
          clientId: providerConfig.clientId,
          clientSecret: "",
        });
      }
    }, [providerConfig?.clientId, form]);

    // Handle OAuth callback redirects (`?google-drive=connected|error`).
    useEffect(() => {
      const status = searchParams.get("google-drive");
      if (!status) return;
      if (status === "connected") {
        toast.success("Google Drive connected");
        queryClient.invalidateQueries({ queryKey: ["storage"] });
        queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
      } else if (status === "error") {
        const reason = searchParams.get("reason") ?? "unknown";
        const message =
          OAUTH_ERROR_MESSAGES[reason] ??
          `Google Drive connection failed (${reason})`;
        toast.error(message);
      }
      // Strip the params so a refresh doesn't re-fire the toast.
      const next = new URLSearchParams(searchParams);
      next.delete("google-drive");
      next.delete("reason");
      setSearchParams(next, { replace: true });
    }, [searchParams, setSearchParams, queryClient]);

    const handleSaveCredentials = async (data: DriveSettingsFormData) => {
      try {
        await updateConfig.mutateAsync({
          clientId: data.clientId,
          clientSecret: data.clientSecret,
        });
        toast.success("Google Drive credentials saved");
        // Reset just the secret so the operator doesn't see their old value.
        form.reset({ clientId: data.clientId, clientSecret: "" });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to save Drive credentials",
        );
      }
    };

    const handleConnect = () => {
      // Top-level navigation so Google's consent screen renders correctly.
      window.location.assign(authorizeUrl);
    };

    const handleDisconnect = async () => {
      try {
        await disconnect.mutateAsync();
        toast.success("Google Drive disconnected");
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to disconnect Google Drive",
        );
      }
    };

    const isConnected = !!providerConfig?.isConnected;
    const credentialsSaved = !!providerConfig?.clientIdConfigured;

    const statusBadge = useMemo(() => {
      if (isConnected) {
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200">
            <IconCircleCheck className="h-3 w-3" /> Connected
          </span>
        );
      }
      if (credentialsSaved) {
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-200">
            <IconCircleX className="h-3 w-3" /> Not connected
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Not configured
        </span>
      );
    }, [isConnected, credentialsSaved]);

    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconBrandGoogleDrive className="h-5 w-5" />
            Google Drive
            {statusBadge}
          </CardTitle>
          <CardDescription>
            Connect a Google Cloud OAuth client (drive.file scope). Mini Infra
            stores the client secret encrypted at rest. Register{" "}
            <code className="text-xs">/api/storage/google-drive/oauth/callback</code>{" "}
            as an Authorised redirect URI in your Google Cloud Console.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {configLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-20" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            <>
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(handleSaveCredentials)}
                  className="space-y-4"
                >
                  <FormField
                    control={form.control}
                    name="clientId"
                    render={({ field }) => (
                      <FormItem data-tour="storage-google-drive-client-id-input">
                        <FormLabel className="flex items-center gap-2">
                          <IconShield className="h-4 w-4" /> Client ID
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="text"
                            placeholder="1234567890-abc.apps.googleusercontent.com"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="clientSecret"
                    render={({ field }) => (
                      <FormItem data-tour="storage-google-drive-client-secret-input">
                        <FormLabel className="flex items-center gap-2">
                          <IconShield className="h-4 w-4" /> Client Secret
                        </FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type={showSecret ? "text" : "password"}
                              placeholder={
                                credentialsSaved
                                  ? "Stored — leave empty to keep current value"
                                  : "GOCSPX-..."
                              }
                              {...field}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-0 top-0 h-full px-2"
                              onClick={() => setShowSecret((s) => !s)}
                            >
                              {showSecret ? (
                                <IconEyeOff className="h-4 w-4" />
                              ) : (
                                <IconEye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    disabled={updateConfig.isPending || !form.formState.isValid}
                    data-tour="storage-google-drive-save-credentials"
                  >
                    {updateConfig.isPending && (
                      <IconLoader2 className="h-4 w-4 animate-spin" />
                    )}
                    Save credentials
                  </Button>
                </form>
              </Form>

              {credentialsSaved ? (
                <div className="space-y-3 rounded-lg border p-4">
                  {isConnected ? (
                    <>
                      <div className="flex items-center gap-2 text-sm">
                        <IconCircleCheck className="h-4 w-4 text-green-600" />
                        <span>
                          Connected as{" "}
                          <strong>
                            {providerConfig?.accountEmail ?? "Google account"}
                          </strong>
                        </span>
                      </div>
                      {providerConfig?.tokenExpiresAt && (
                        <p className="text-xs text-muted-foreground">
                          Access token expires{" "}
                          {new Date(
                            providerConfig.tokenExpiresAt,
                          ).toLocaleString()}
                          . Mini Infra refreshes it automatically.
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          onClick={handleConnect}
                          data-tour="storage-google-drive-reconnect"
                        >
                          <IconExternalLink className="h-4 w-4" /> Re-authorise
                        </Button>
                        <Button
                          variant="outline"
                          onClick={handleDisconnect}
                          disabled={disconnect.isPending}
                          data-tour="storage-google-drive-disconnect"
                        >
                          {disconnect.isPending ? (
                            <IconLoader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <IconUnlink className="h-4 w-4" />
                          )}
                          Disconnect
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Alert>
                        <IconCircleX className="h-4 w-4" />
                        <AlertDescription>
                          Credentials saved — now authorise Mini Infra against
                          your Google account.
                        </AlertDescription>
                      </Alert>
                      <Button
                        onClick={handleConnect}
                        data-tour="storage-google-drive-connect"
                      >
                        <IconExternalLink className="h-4 w-4" /> Connect to
                        Google Drive
                      </Button>
                    </>
                  )}
                </div>
              ) : (
                <Alert>
                  <IconShield className="h-4 w-4" />
                  <AlertDescription>
                    Save your Google OAuth client ID and secret first. Then
                    Mini Infra will redirect you to Google to grant access to
                    Drive.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>
    );
  },
);
