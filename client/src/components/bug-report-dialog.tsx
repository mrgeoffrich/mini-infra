import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconBug,
  IconLoader2,
  IconCircleCheck,
  IconAlertCircle,
  IconBrandGithub,
} from "@tabler/icons-react";
import { useSubmitBugReport } from "@/hooks/use-bug-report";
import { useGitHubSettings } from "@/hooks/use-github-settings";
import type { BugReportSystemInfo } from "@mini-infra/types";
import { toast } from "sonner";

const bugReportSchema = z.object({
  title: z.string().min(1, "Title is required").max(256, "Title is too long"),
  description: z
    .string()
    .min(10, "Description must be at least 10 characters")
    .max(5000, "Description is too long"),
  stepsToReproduce: z.string().max(2000).optional(),
  expectedBehavior: z.string().max(1000).optional(),
  actualBehavior: z.string().max(1000).optional(),
});

type BugReportFormData = z.infer<typeof bugReportSchema>;

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BugReportDialog({
  open,
  onOpenChange,
}: BugReportDialogProps) {
  const location = useLocation();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [issueUrl, setIssueUrl] = useState<string>("");

  // Check if GitHub is configured
  const { data: githubSettings } = useGitHubSettings();
  const isGitHubConfigured = githubSettings?.data?.isConfigured || false;

  const { mutate: submitBugReport, isPending } = useSubmitBugReport();

  const form = useForm<BugReportFormData>({
    resolver: zodResolver(bugReportSchema),
    defaultValues: {
      title: "",
      description: "",
      stepsToReproduce: "",
      expectedBehavior: "",
      actualBehavior: "",
    },
  });

  const collectSystemInfo = (): BugReportSystemInfo => {
    return {
      userAgent: navigator.userAgent,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      currentRoute: location.pathname,
      timestamp: new Date().toISOString(),
      platform: navigator.platform,
    };
  };

  const onSubmit = (data: BugReportFormData) => {
    const systemInfo = collectSystemInfo();

    const bugReport = {
      userData: {
        title: data.title,
        description: data.description,
        stepsToReproduce: data.stepsToReproduce,
        expectedBehavior: data.expectedBehavior,
        actualBehavior: data.actualBehavior,
      },
      systemInfo,
    };

    submitBugReport(bugReport, {
      onSuccess: (response) => {
        setIssueUrl(response.data.issueUrl);
        setIsSubmitted(true);
        toast.success("Bug report submitted successfully");
      },
      onError: (error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to submit bug report",
        );
      },
    });
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset state after dialog closes
    setTimeout(() => {
      setIsSubmitted(false);
      setIssueUrl("");
      form.reset();
    }, 300);
  };

  // If not configured, show configuration prompt
  if (!isGitHubConfigured) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              <div className="flex items-center gap-2">
                <IconBrandGithub className="h-5 w-5" />
                GitHub Not Configured
              </div>
            </DialogTitle>
            <DialogDescription>
              Bug reporting requires GitHub to be configured
            </DialogDescription>
          </DialogHeader>

          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Please configure GitHub settings before submitting bug reports.
              You'll need a GitHub personal access token and repository details.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onOpenChange(false);
                window.location.href = "/settings-github";
              }}
            >
              <IconBrandGithub className="mr-2 h-4 w-4" />
              Configure GitHub
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Success state
  if (isSubmitted && issueUrl) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              <div className="flex items-center gap-2">
                <IconCircleCheck className="h-5 w-5 text-green-600" />
                Bug Report Submitted
              </div>
            </DialogTitle>
            <DialogDescription>
              Your bug report has been successfully created
            </DialogDescription>
          </DialogHeader>

          <Alert className="bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
            <IconCircleCheck className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-900 dark:text-green-100">
              Bug report created successfully! You can view and track it on
              GitHub.
            </AlertDescription>
          </Alert>

          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Issue URL:
            </p>
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline break-all"
            >
              {issueUrl}
            </a>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
            <Button
              onClick={() => window.open(issueUrl, "_blank")}
            >
              <IconBrandGithub className="mr-2 h-4 w-4" />
              View on GitHub
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Bug report form
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <IconBug className="h-5 w-5" />
              Report a Bug
            </div>
          </DialogTitle>
          <DialogDescription>
            Help us improve by reporting bugs you encounter. System information
            will be automatically included.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Title */}
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title *</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Brief description of the issue"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    A clear, concise title for the bug report
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description *</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Detailed description of the bug..."
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Provide a detailed description of the issue
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Steps to Reproduce */}
            <FormField
              control={form.control}
              name="stepsToReproduce"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Steps to Reproduce</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="1. Go to...&#10;2. Click on...&#10;3. See error..."
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Steps to reproduce the behavior (optional)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Expected Behavior */}
            <FormField
              control={form.control}
              name="expectedBehavior"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Expected Behavior</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What you expected to happen..."
                      rows={2}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    What should have happened? (optional)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actual Behavior */}
            <FormField
              control={form.control}
              name="actualBehavior"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Actual Behavior</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What actually happened..."
                      rows={2}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    What actually happened? (optional)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Info notice */}
            <Alert>
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                System information (browser, screen resolution, current page)
                will be automatically included with your report.
              </AlertDescription>
            </Alert>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || !form.formState.isValid}>
                {isPending ? (
                  <>
                    <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <IconBug className="mr-2 h-4 w-4" />
                    Submit Bug Report
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
