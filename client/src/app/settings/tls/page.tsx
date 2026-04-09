import { useEffect } from "react";
import {
  IconSettings,
} from "@tabler/icons-react";
import {
  useTlsSettings,
  useUpdateTlsSettings,
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

export default function TlsSettingsPage() {
  const { data: settings, isLoading } = useTlsSettings();
  const { mutate: updateSettings, isPending } = useUpdateTlsSettings();

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

      <div className="px-4 lg:px-6 max-w-7xl">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ACME configuration */}
          <Card>
            <CardHeader>
              <CardTitle>ACME Provider</CardTitle>
              <CardDescription>
                Let's Encrypt certificate authority settings
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4">
                <div data-tour="tls-acme-provider">
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

                <div data-tour="tls-acme-email">
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

          {/* Renewal scheduler configuration */}
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
    </div>
  );
}
