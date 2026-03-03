import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  useGitHubSettings,
  useUpdateGitHubSettings,
  useTestGitHubConnection,
} from "@/hooks/use-github-settings";
import {
  IconAlertCircle,
  IconDeviceFloppy,
  IconLoader2,
  IconBrandGithub,
  IconCircleCheck,
  IconPlugConnected,
} from "@tabler/icons-react";
import { toast } from "sonner";

// GitHub settings schema
const githubSettingsSchema = z.object({
  personal_access_token: z
    .string()
    .min(1, "Personal access token is required")
    .regex(
      /^(gh[a-z]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]+)$/,
      "Invalid GitHub personal access token format (must start with ghp_, github_pat_, etc.)",
    ),
  repo_owner: z
    .string()
    .min(1, "Repository owner is required")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
      "Invalid repository owner format",
    ),
  repo_name: z
    .string()
    .min(1, "Repository name is required")
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Invalid repository name format",
    ),
});

type GitHubSettingsFormData = z.infer<typeof githubSettingsSchema>;

export default function GitHubSettingsPage() {
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  // Fetch existing GitHub settings
  const {
    data: settingsData,
    isLoading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings,
  } = useGitHubSettings();

  // Mutations
  const updateSettings = useUpdateGitHubSettings();
  const testConnection = useTestGitHubConnection();

  // Form setup
  const form = useForm<GitHubSettingsFormData>({
    resolver: zodResolver(githubSettingsSchema),
    defaultValues: {
      personal_access_token: "",
      repo_owner: "",
      repo_name: "",
    },
    mode: "onChange",
  });

  // Update form when settings are loaded
  useEffect(() => {
    if (settingsData?.data) {
      if (settingsData.data.repoOwner) {
        form.setValue("repo_owner", settingsData.data.repoOwner);
      }
      if (settingsData.data.repoName) {
        form.setValue("repo_name", settingsData.data.repoName);
      }
      // Note: We don't pre-fill the token for security reasons
    }
  }, [settingsData, form]);

  // Handle form submission
  const onSubmit = async (data: GitHubSettingsFormData) => {
    setIsSaving(true);

    try {
      await updateSettings.mutateAsync({
        personal_access_token: data.personal_access_token,
        repo_owner: data.repo_owner,
        repo_name: data.repo_name,
        encrypt: true,
      });

      toast.success("GitHub settings saved successfully");
      await refetchSettings();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save settings",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Handle test connection
  const handleTestConnection = async () => {
    setIsTesting(true);

    try {
      const formValues = form.getValues();
      const result = await testConnection.mutateAsync({
        personal_access_token: formValues.personal_access_token || undefined,
        repo_owner: formValues.repo_owner || undefined,
        repo_name: formValues.repo_name || undefined,
      });

      if (result.data.isValid) {
        toast.success(result.data.message || "Connection successful");
      } else {
        toast.error(result.data.message || "Connection failed");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Connection test failed",
      );
    } finally {
      setIsTesting(false);
    }
  };

  // Loading state
  if (settingsLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-12 w-64" />
        </div>
      </div>
    );
  }

  // Error state
  if (settingsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {settingsError instanceof Error
                ? settingsError.message
                : "Failed to load GitHub settings"}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const isConfigured = settingsData?.data?.isConfigured || false;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconBrandGithub className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Bug Report Settings</h1>
            <p className="text-muted-foreground">
              Configure GitHub integration for bug reporting
            </p>
          </div>
        </div>
      </div>

      {/* Configuration Status */}
      {isConfigured && (
        <div className="px-4 lg:px-6 max-w-7xl">
          <Alert>
            <IconCircleCheck className="h-4 w-4 text-green-600" />
            <AlertDescription>
              GitHub is configured and ready for bug reporting to{" "}
              <strong>
                {settingsData?.data?.repoOwner}/{settingsData?.data?.repoName}
              </strong>
            </AlertDescription>
          </Alert>
        </div>
      )}

      {/* Settings Form */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Repository Configuration</CardTitle>
            <CardDescription>
              Configure your GitHub personal access token and repository for bug
              reporting. Your token will be encrypted and stored securely.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                {/* Personal Access Token */}
                <FormField
                  control={form.control}
                  name="personal_access_token"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Personal Access Token</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="ghp_xxxxxxxxxxxx"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Your GitHub personal access token with 'repo' and
                        'issues:write' permissions.{" "}
                        <a
                          href="https://github.com/settings/tokens/new?description=Mini%20Infra%20Bug%20Reporter&scopes=repo"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          Create a new token
                        </a>
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Repository Owner */}
                <FormField
                  control={form.control}
                  name="repo_owner"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Repository Owner</FormLabel>
                      <FormControl>
                        <Input placeholder="username or organization" {...field} />
                      </FormControl>
                      <FormDescription>
                        The GitHub username or organization that owns the
                        repository
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Repository Name */}
                <FormField
                  control={form.control}
                  name="repo_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Repository Name</FormLabel>
                      <FormControl>
                        <Input placeholder="repository-name" {...field} />
                      </FormControl>
                      <FormDescription>
                        The name of the repository where bug reports will be
                        created
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Action Buttons */}
                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    disabled={isSaving || !form.formState.isValid}
                  >
                    {isSaving ? (
                      <>
                        <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <IconDeviceFloppy className="mr-2 h-4 w-4" />
                        Save Settings
                      </>
                    )}
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleTestConnection}
                    disabled={isTesting || !form.formState.isValid}
                  >
                    {isTesting ? (
                      <>
                        <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                        Testing...
                      </>
                    ) : (
                      <>
                        <IconPlugConnected className="mr-2 h-4 w-4" />
                        Test Connection
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>

      {/* Help Section */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>How to Get a Personal Access Token</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="list-decimal list-inside space-y-2 text-sm">
              <li>
                Go to{" "}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub Settings → Developer settings → Personal access tokens
                </a>
              </li>
              <li>
                Click "Generate new token" → "Generate new token (classic)"
              </li>
              <li>
                Give it a descriptive name like "Mini Infra Bug Reporter"
              </li>
              <li>Select the following scopes:
                <ul className="list-disc list-inside ml-6 mt-1">
                  <li><code>repo</code> (Full control of private repositories)</li>
                </ul>
              </li>
              <li>Click "Generate token" at the bottom of the page</li>
              <li>
                Copy the token (it starts with <code>ghp_</code>) and paste it above
              </li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
