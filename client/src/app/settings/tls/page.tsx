import { useEffect, useState } from "react";
import {
  IconSettings,
  IconLoader2,
  IconRefresh,
  IconPlugConnected,
  IconAlertCircle,
} from "@tabler/icons-react";
import {
  useTlsSettings,
  useUpdateTlsSettings,
  useTestTlsConnectivity,
  useTlsContainers,
} from "@/hooks/use-tls-settings";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function TlsSettingsPage() {
  const { data: settings, isLoading } = useTlsSettings();
  const { mutate: updateSettings, isPending } = useUpdateTlsSettings();
  const { mutate: testConnectivity, isPending: isTesting } =
    useTestTlsConnectivity();
  const {
    data: containers,
    isLoading: containersLoading,
    refetch: refetchContainers,
  } = useTlsContainers();

  const [connectionTestResult, setConnectionTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const form = useForm({
    defaultValues: {
      certificate_blob_container: "",
      default_acme_provider: "letsencrypt",
      default_acme_email: "",
      renewal_check_cron: "0 2 * * *",
      renewal_days_before_expiry: "30",
    },
  });

  // Update form when settings load, merging with defaults so unset fields keep their default values
  useEffect(() => {
    if (settings) {
      form.reset({ ...form.formState.defaultValues, ...settings });
    }
  }, [settings, form]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-12 w-64" />
        </div>
      </div>
    );
  }

  const handleSave = () => {
    updateSettings(form.getValues());
  };

  const handleTest = async () => {
    setConnectionTestResult(null);
    const values = form.getValues();

    try {
      const result = await new Promise<{ success: boolean; error?: string }>(
        (resolve, reject) => {
          testConnectivity(
            { certificate_blob_container: values.certificate_blob_container },
            {
              onSuccess: (data) => resolve(data),
              onError: (error) => reject(error),
            }
          );
        }
      );

      setConnectionTestResult({
        success: result.success,
        message: result.success
          ? "Connection successful! Azure Storage container is accessible."
          : result.error || "Connection failed",
      });
    } catch (error) {
      setConnectionTestResult({
        success: false,
        message: error instanceof Error ? error.message : "Connection test failed",
      });
    }
  };

  const handleRefreshContainers = () => {
    refetchContainers();
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconSettings className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">TLS Configuration</h1>
            <p className="text-muted-foreground">
              Configure Azure Storage and ACME settings for certificate
              management
            </p>
          </div>
        </div>
      </div>

      {/* Certificate Storage Configuration */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Certificate Storage</CardTitle>
            <CardDescription>
              Certificates are stored in Azure Blob Storage using the existing
              Azure Storage connection configured for PostgreSQL backups.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Info about existing Azure Storage connection */}
            <div className="rounded-md bg-blue-50 p-4 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-100">
              <p className="font-medium">Using Azure Storage Connection</p>
              <p className="mt-1 text-blue-700 dark:text-blue-200">
                This uses the same Azure Storage account configured in Settings
                → Azure Storage. Certificates will be stored in the container
                you select below.
              </p>
            </div>

            {/* Container Selection Dropdown */}
            <div className="space-y-2">
              <Label htmlFor="certificate_blob_container">
                Certificate Container
              </Label>
              <div className="flex gap-2">
                <Select
                  value={form.watch("certificate_blob_container") || ""}
                  onValueChange={(value) =>
                    form.setValue("certificate_blob_container", value)
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select a container..." />
                  </SelectTrigger>
                  <SelectContent>
                    {containersLoading ? (
                      <SelectItem value="__loading__" disabled>
                        Loading containers...
                      </SelectItem>
                    ) : !containers || containers.length === 0 ? (
                      <SelectItem value="__none__" disabled>
                        No containers available
                      </SelectItem>
                    ) : (
                      containers.map((container) => (
                        <SelectItem key={container} value={container}>
                          {container}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>

                {/* Refresh Button */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRefreshContainers}
                  disabled={containersLoading}
                >
                  {containersLoading ? (
                    <>
                      <IconRefresh className="h-4 w-4 mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    <>
                      <IconRefresh className="h-4 w-4 mr-2" />
                      Refresh
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Select the Azure Storage container where TLS certificates will
                be stored. The container must already exist.
              </p>
            </div>

            {/* Test Connection Button */}
            <Button
              type="button"
              variant="outline"
              onClick={handleTest}
              disabled={
                isTesting || !form.watch("certificate_blob_container")
              }
            >
              {isTesting ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Testing Connection...
                </>
              ) : (
                <>
                  <IconPlugConnected className="h-4 w-4 mr-2" />
                  Test Connection
                </>
              )}
            </Button>

            {/* Connection Test Result */}
            {connectionTestResult && (
              <Alert
                variant={
                  connectionTestResult.success ? "default" : "destructive"
                }
              >
                {!connectionTestResult.success && (
                  <IconAlertCircle className="h-4 w-4" />
                )}
                <AlertDescription>
                  {connectionTestResult.message}
                </AlertDescription>
              </Alert>
            )}

            {/* Save Button */}
            <Button type="button" onClick={handleSave} disabled={isPending}>
              {isPending ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Settings"
              )}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ACME configuration */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>ACME Provider</CardTitle>
            <CardDescription>
              Let's Encrypt certificate authority settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4">
              <div>
                <Label>Provider</Label>
                <Select
                  value={form.watch("default_acme_provider") || "letsencrypt"}
                  onValueChange={(value) =>
                    form.setValue("default_acme_provider", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select ACME provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="letsencrypt">
                      Let's Encrypt (Production)
                    </SelectItem>
                    <SelectItem value="letsencrypt-staging">
                      Let's Encrypt (Staging)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Use staging for testing to avoid rate limits
                </p>
              </div>

              <div>
                <Label>Email Address</Label>
                <Input
                  type="email"
                  placeholder="admin@example.com"
                  {...form.register("default_acme_email")}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Used for ACME account registration and renewal notifications
                </p>
              </div>

              <Button type="button" onClick={handleSave} disabled={isPending}>
                Save Settings
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Renewal scheduler configuration */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Renewal Scheduler</CardTitle>
            <CardDescription>
              Automatic certificate renewal configuration
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4">
              <div>
                <Label>Check Schedule (Cron)</Label>
                <Input
                  placeholder="0 2 * * *"
                  {...form.register("renewal_check_cron")}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Default: Daily at 2 AM (0 2 * * *)
                </p>
              </div>

              <div>
                <Label>Renew Days Before Expiry</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  {...form.register("renewal_days_before_expiry", {
                    valueAsNumber: true,
                  })}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Certificates will renew this many days before expiration
                </p>
              </div>

              <Button type="button" onClick={handleSave} disabled={isPending}>
                Save Settings
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
