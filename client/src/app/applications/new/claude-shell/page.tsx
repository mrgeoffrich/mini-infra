import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  IconArrowLeft,
  IconLoader2,
  IconTerminal,
  IconAlertCircle,
} from "@tabler/icons-react";
import {
  useCreateApplication,
} from "@/hooks/use-applications";
import { useEnvironments } from "@/hooks/use-environments";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import type {
  CreateStackTemplateRequest,
  StackServiceDefinition,
} from "@mini-infra/types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  claudeShellFormDefaults,
  claudeShellFormSchema,
  parseExtraTags,
  slugifyClaudeShellName,
  CLAUDE_SHELL_IMAGE,
  CLAUDE_SHELL_DEFAULT_TAG,
  CLAUDE_SHELL_SERVICE_NAME,
  type ClaudeShellFormData,
} from "@/lib/claude-shell-form";

/**
 * Phase 6 of the Claude Shell plan — Applications-page preset.
 *
 * Renders a focused create-form that builds a stack template with one
 * `Stateful` service backed by the published `mini-infra-claude-shell` image
 * and the `claude-shell` addon pre-populated. The submission flow:
 *
 *   1. POST /api/stack-templates           (deployImmediately=true)
 *   2. POST /api/stack-templates/:id/publish
 *   3. POST /api/stack-templates/:id/instantiate
 *   4. PUT  /api/stacks/:stackId/services/shell/git-deploy-key  (if key provided)
 *   5. POST /api/stacks/:stackId/apply
 *
 * Steps 1–3 + 5 ride on the existing `useCreateApplication` hook; step 4 is
 * threaded into the hook via the new `onStackInstantiated` callback so the
 * key is in place before the very first apply.
 *
 * The private key is held only in form state. On success the form's reset
 * fires and the value is dropped from React state; we also never log it or
 * push it through TanStack Query (the mutation body is consumed once).
 */
export default function NewClaudeShellPage() {
  const navigate = useNavigate();
  const createApplication = useCreateApplication();
  const { registerTask } = useTaskTracker();
  const [keyUploadError, setKeyUploadError] = useState<string | null>(null);

  const { data: envData, isLoading: environmentsLoading } = useEnvironments();
  const environments = useMemo(
    () => envData?.environments ?? [],
    [envData?.environments],
  );

  const form = useForm<ClaudeShellFormData>({
    resolver: zodResolver(claudeShellFormSchema),
    defaultValues: claudeShellFormDefaults,
  });

  // Auto-select single environment (mirrors `BasicsStep` behaviour for parity).
  const currentEnvId = useWatch({
    control: form.control,
    name: "environmentId",
  });
  useEffect(() => {
    if (
      !environmentsLoading &&
      environments.length === 1 &&
      !currentEnvId
    ) {
      form.setValue("environmentId", environments[0].id, {
        shouldValidate: true,
      });
    }
  }, [environmentsLoading, environments, currentEnvId, form]);

  const gitRepo = useWatch({ control: form.control, name: "gitRepo" }) ?? "";
  const hasGitRepo = gitRepo.trim().length > 0;

  const onSubmit = async (data: ClaudeShellFormData) => {
    setKeyUploadError(null);
    const stackName = slugifyClaudeShellName(data.name);
    if (!stackName) {
      toast.error("Name must contain at least one alphanumeric character");
      return;
    }

    const extraTags = parseExtraTags(data.extraTagsRaw);
    const claudeShellConfig: Record<string, unknown> = {};
    if (data.gitRepo && data.gitRepo.trim().length > 0) {
      claudeShellConfig.gitRepo = data.gitRepo.trim();
    }
    if (extraTags && extraTags.length > 0) {
      claudeShellConfig.extraTags = extraTags;
    }

    const service: StackServiceDefinition = {
      serviceName: CLAUDE_SHELL_SERVICE_NAME,
      serviceType: "Stateful",
      dockerImage: CLAUDE_SHELL_IMAGE,
      dockerTag: CLAUDE_SHELL_DEFAULT_TAG,
      containerConfig: {
        // Persistent volumes for the workspace (cloned repos) and the
        // home dir (so `claude login` OAuth tokens survive container
        // recreates — matches the entrypoint's HOME=/home/claude default).
        mounts: [
          {
            source: `${stackName}-workspace`,
            target: "/workspace",
            type: "volume",
          },
          {
            source: `${stackName}-home`,
            target: "/home/claude",
            type: "volume",
          },
        ],
        restartPolicy: "unless-stopped",
      },
      dependsOn: [],
      order: 0,
      addons: {
        "claude-shell":
          Object.keys(claudeShellConfig).length > 0 ? claudeShellConfig : {},
      },
    };

    const request: CreateStackTemplateRequest = {
      name: stackName,
      displayName: data.name,
      description: "Claude Shell — developer container with Claude Code over Tailscale SSH",
      scope: "environment",
      environmentId: data.environmentId,
      deployImmediately: true,
      networks: [],
      volumes: [
        { name: `${stackName}-workspace` },
        { name: `${stackName}-home` },
      ],
      services: [service],
    };

    // Snapshot the key once; the form state is reset on success so the
    // value is dropped from React state immediately afterwards.
    const deployKey = data.gitDeployKey?.trim() ?? "";

    try {
      const result = await createApplication.mutateAsync({
        ...request,
        onStackInstantiated: async (stackId: string) => {
          if (!deployKey) return;
          const res = await fetch(
            `/api/stacks/${stackId}/services/${CLAUDE_SHELL_SERVICE_NAME}/git-deploy-key`,
            {
              method: "PUT",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              // NOTE: never log this body. The Vault KV service stores it
              // opaque; the route logs only `git-deploy-key written`.
              body: JSON.stringify({ privateKey: deployKey }),
            },
          );
          if (!res.ok) {
            let message = `Deploy key upload failed: ${res.statusText}`;
            try {
              const body = await res.json();
              if (body?.message) message = `Deploy key upload failed: ${body.message}`;
            } catch {
              // fall through to default
            }
            setKeyUploadError(message);
            throw new Error(message);
          }
        },
        onStackCreated: (stackId: string) => {
          registerTask({
            id: stackId,
            type: "stack-apply",
            label: `Deploying Claude Shell — ${data.name}`,
            channel: Channel.STACKS,
          });
        },
      });
      // Drop any in-memory key material from the form state.
      form.reset({ ...claudeShellFormDefaults });
      // Redirect to the new application's detail page.
      navigate(`/applications/${result.data.id}`);
    } catch {
      // useCreateApplication surfaces the toast; the dedicated key-upload
      // banner remains for the specific deploy-key failure (set above).
    }
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/applications")}
          className="mb-4"
          data-tour="claude-shell-back-button"
        >
          <IconArrowLeft className="mr-1 h-4 w-4" />
          Back to Applications
        </Button>

        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconTerminal className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">New Claude Shell</h1>
            <p className="mt-1 text-muted-foreground">
              Developer container with Claude Code, accessible via Tailscale SSH.
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl px-4 lg:px-6">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            data-tour="claude-shell-form"
          >
            <Card>
              <CardHeader>
                <CardTitle>Basics</CardTitle>
                <CardDescription>
                  Stack name and target environment. The name is slugified to
                  form the stack ID and the names of its persistent volumes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem data-tour="claude-shell-name-input">
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="My Claude Shell"
                            autoFocus
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Will be slugified — e.g. &quot;My Shell&quot; →{" "}
                          <code>my-shell</code>.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="environmentId"
                    render={({ field }) => (
                      <FormItem data-tour="claude-shell-environment-select">
                        <FormLabel>Environment</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? ""}
                          disabled={environmentsLoading}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue
                                placeholder={
                                  environmentsLoading
                                    ? "Loading environments..."
                                    : "Select an environment"
                                }
                              />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {environments.map((env) => (
                              <SelectItem key={env.id} value={env.id}>
                                {env.name}
                                <span className="ml-2 text-xs text-muted-foreground">
                                  ({env.networkType})
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Git repository (optional)</CardTitle>
                <CardDescription>
                  Clone a repo into <code>/workspace</code> on first start. For
                  private repos, also upload an SSH deploy key — it&apos;s
                  stored in Vault and injected at apply time.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="gitRepo"
                  render={({ field }) => (
                    <FormItem data-tour="claude-shell-git-repo-input">
                      <FormLabel>Git repo URL</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="git@github.com:owner/repo.git"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Either <code>https://</code> URL (public) or{" "}
                        <code>git@host:path</code> SSH URL (uses deploy key).
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="gitDeployKey"
                  render={({ field }) => (
                    <FormItem data-tour="claude-shell-deploy-key-input">
                      <FormLabel>SSH deploy key (PEM)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder={
                            hasGitRepo
                              ? "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"
                              : "Fill in a git repo URL first"
                          }
                          rows={6}
                          spellCheck={false}
                          autoComplete="off"
                          className="font-mono text-xs"
                          disabled={!hasGitRepo}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Paste the contents of a PEM-encoded private key (e.g.{" "}
                        <code>~/.ssh/id_ed25519</code>). The key is sent
                        directly to Vault and never logged or echoed back.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Accordion type="single" collapsible>
              <AccordionItem value="advanced">
                <AccordionTrigger>Advanced</AccordionTrigger>
                <AccordionContent>
                  <Card>
                    <CardContent className="pt-6">
                      <FormField
                        control={form.control}
                        name="extraTagsRaw"
                        render={({ field }) => (
                          <FormItem data-tour="claude-shell-extra-tags-input">
                            <FormLabel>Extra tailnet tags</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="tag:dev-team, tag:claude-shell"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              Comma-separated. Each tag must start with{" "}
                              <code>tag:</code> and already exist in your
                              tailnet&apos;s <code>tagOwners</code> ACL.
                              Layered on top of the default{" "}
                              <code>tag:mini-infra-managed</code>.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </CardContent>
                  </Card>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {keyUploadError && (
              <Alert variant="destructive">
                <IconAlertCircle className="h-4 w-4" />
                <AlertDescription>{keyUploadError}</AlertDescription>
              </Alert>
            )}

            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate("/applications")}
                disabled={createApplication.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createApplication.isPending}
                data-tour="claude-shell-create-button"
              >
                {createApplication.isPending && (
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Create Claude Shell
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
