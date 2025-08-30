import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCreateJob } from "@/hooks/use-jobs";
import {
  Play,
  Github,
  FileText,
  Settings,
  Loader2,
  HelpCircle,
  Eye,
  EyeOff,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { CreateJobRequest } from "@mini-infra/types";

// Job creation form schema with validation
const jobCreationSchema = z.object({
  repositoryUrl: z
    .string()
    .min(1, "Repository URL is required")
    .url("Please enter a valid URL")
    .refine((url) => {
      // Support GitHub URLs in various formats
      const githubPattern =
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?(?:\.git)?$/;
      const sshPattern = /^git@github\.com:[\w.-]+\/[\w.-]+\.git$/;
      return githubPattern.test(url) || sshPattern.test(url);
    }, "Please enter a valid GitHub repository URL"),
  githubToken: z
    .string()
    .min(1, "GitHub token is required")
    .min(20, "GitHub token must be at least 20 characters")
    .regex(
      /^gh[ps]_[A-Za-z0-9_]{36,}$/,
      "Please enter a valid GitHub Personal Access Token",
    ),
  storyFile: z
    .string()
    .min(1, "Story file path is required")
    .refine(
      (path) => !path.startsWith("/"),
      "Path should be relative to repository root (don't start with /)",
    )
    .refine(
      (path) => path.endsWith(".md"),
      "Story file should be a markdown file (.md)",
    ),
  architectureDoc: z
    .string()
    .min(1, "Architecture document path is required")
    .refine(
      (path) => !path.startsWith("/"),
      "Path should be relative to repository root (don't start with /)",
    )
    .refine(
      (path) => path.endsWith(".md"),
      "Architecture document should be a markdown file (.md)",
    ),
  branchPrefix: z
    .string()
    .optional()
    .refine(
      (prefix) => !prefix || /^[a-zA-Z][a-zA-Z0-9-_]*$/.test(prefix),
      "Branch prefix must start with a letter and contain only letters, numbers, hyphens, and underscores",
    ),
  featureBranch: z
    .string()
    .optional()
    .refine(
      (branch) => !branch || /^[a-zA-Z][a-zA-Z0-9-_/]*$/.test(branch),
      "Feature branch must start with a letter and contain only letters, numbers, hyphens, underscores, and forward slashes",
    ),
  customPrompt: z.string().optional(),
});

type JobCreationFormData = z.infer<typeof jobCreationSchema>;

export default function YoloClaudePage() {
  const navigate = useNavigate();
  const [showToken, setShowToken] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form setup
  const form = useForm<JobCreationFormData>({
    resolver: zodResolver(jobCreationSchema),
    defaultValues: {
      repositoryUrl: "",
      githubToken: "",
      storyFile: "user-stories.md",
      architectureDoc: "architecture.md",
      branchPrefix: "story",
      featureBranch: "",
      customPrompt: "",
    },
    mode: "onChange",
  });

  // Job creation mutation
  const createJob = useCreateJob();

  const handleSubmit = async (data: JobCreationFormData) => {
    setIsSubmitting(true);
    try {
      const jobRequest: CreateJobRequest = {
        repositoryUrl: data.repositoryUrl,
        githubToken: data.githubToken,
        storyFile: data.storyFile,
        architectureDoc: data.architectureDoc,
        branchPrefix: data.branchPrefix || "story",
        featureBranch: data.featureBranch || undefined,
        customPrompt: data.customPrompt || undefined,
      };

      const response = await createJob.mutateAsync(jobRequest);

      toast.success(
        "Job created successfully! Redirecting to execution view...",
      );

      // Navigate to job execution view
      navigate(`/yolo-claude/jobs/${response.jobId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to create job. Please try again.";
      toast.error(`Failed to create job: ${errorMessage}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isFormValid = form.formState.isValid;
  const isLoading = isSubmitting || createJob.isPending;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300">
            <Play className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">YoloClaude - Story Runner</h1>
            <p className="text-muted-foreground">
              Run Claude Code over story sets with automated implementation
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-4xl mx-auto w-full">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Job Configuration
            </CardTitle>
            <CardDescription>
              Configure your repository and story settings to start an automated
              Claude Code implementation job.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(handleSubmit)}
                className="space-y-6"
              >
                {/* Repository Configuration Section */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <Github className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                      Repository Configuration
                    </h3>
                  </div>

                  <FormField
                    control={form.control}
                    name="repositoryUrl"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center gap-2">
                          <FormLabel>Repository URL</FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                              >
                                <HelpCircle className="h-4 w-4" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80">
                              <div className="space-y-3">
                                <div className="text-sm space-y-2">
                                  <div>
                                    <strong>HTTPS format:</strong>
                                  </div>
                                  <code className="text-xs bg-muted px-2 py-1 rounded block">
                                    https://github.com/username/repository
                                  </code>
                                  <div>
                                    <strong>SSH format:</strong>
                                  </div>
                                  <code className="text-xs bg-muted px-2 py-1 rounded block">
                                    git@github.com:username/repository.git
                                  </code>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </div>
                        <FormControl>
                          <Input
                            placeholder="https://github.com/username/repository"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          The GitHub repository URL where your user stories and
                          architecture documentation are stored.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="githubToken"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center gap-2">
                          <FormLabel>GitHub Personal Access Token</FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                              >
                                <HelpCircle className="h-4 w-4" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80">
                              <div className="space-y-3">
                                <div className="text-sm space-y-2">
                                  <p>
                                    <strong>Required permissions:</strong>
                                  </p>
                                  <ul className="text-xs list-disc list-inside space-y-1">
                                    <li>
                                      repo (Full control of private
                                      repositories)
                                    </li>
                                    <li>Contents read/write permissions</li>
                                  </ul>
                                  <p className="text-xs text-muted-foreground mt-2">
                                    Create a token at: github.com → Settings →
                                    Developer settings → Personal access tokens
                                  </p>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </div>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type={showToken ? "text" : "password"}
                              placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                              {...field}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-0 top-0 h-full px-3"
                              onClick={() => setShowToken(!showToken)}
                            >
                              {showToken ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </FormControl>
                        <FormDescription>
                          GitHub Personal Access Token with repo permissions.
                          This will be encrypted in transit and stored securely.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* File Paths Section */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                      Story Configuration
                    </h3>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="storyFile"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Story File Path</FormLabel>
                          <FormControl>
                            <Input placeholder="user-stories.md" {...field} />
                          </FormControl>
                          <FormDescription>
                            Relative path to the user stories markdown file
                            within the repository.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="architectureDoc"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Architecture Document Path</FormLabel>
                          <FormControl>
                            <Input placeholder="architecture.md" {...field} />
                          </FormControl>
                          <FormDescription>
                            Relative path to the architecture documentation
                            within the repository.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>

                {/* Advanced Options Section */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <Settings className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                      Advanced Options
                    </h3>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="branchPrefix"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Branch Prefix</FormLabel>
                          <FormControl>
                            <Input placeholder="story" {...field} />
                          </FormControl>
                          <FormDescription>
                            Prefix for story branch names. Default: "story"
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="featureBranch"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Feature Branch (Optional)</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="feature/new-functionality"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Create a feature branch as the base for all story
                            branches.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="customPrompt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Custom Prompt (Optional)</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Override the default implementation prompt with custom instructions..."
                            className="min-h-[100px]"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Provide custom instructions to override the default
                          implementation prompt.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Error Display */}
                {createJob.error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      {createJob.error instanceof Error
                        ? createJob.error.message
                        : "Failed to create job. Please try again."}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Submit Button */}
                <div className="flex justify-end pt-6">
                  <Button
                    type="submit"
                    size="lg"
                    disabled={!isFormValid || isLoading}
                    className="min-w-[200px]"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating Job...
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        Start Story Implementation
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
