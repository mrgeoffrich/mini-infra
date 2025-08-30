import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Play,
  Square,
  RefreshCw,
  ArrowLeft,
  Terminal,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Wifi,
  WifiOff,
  Copy,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useJobDetails, useJobStatus } from "@/hooks/use-jobs";
import { JobStatus, JobLog } from "@mini-infra/types";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";

export default function JobExecutionPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [sessionId] = useState(
    () => `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  );

  // Fetch job details
  const {
    data: jobDetails,
    isLoading: isLoadingJob,
    error: jobError,
    refetch: refetchJob,
  } = useJobDetails(jobId!, {
    enabled: !!jobId,
  });

  // Connect to SSE for real-time updates
  const {
    status,
    progress,
    logs,
    error: sseError,
    isComplete,
    isConnected,
    resetLogs,
    disconnect,
  } = useJobStatus(sessionId, jobId);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  // Handle scroll events to detect manual scrolling
  const handleLogScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const isAtBottom =
        element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
      setAutoScroll(isAtBottom);
    },
    [],
  );

  // Navigate back to job creation
  const handleGoBack = useCallback(() => {
    navigate("/yolo-claude");
  }, [navigate]);

  // Start a new job
  const handleStartNewJob = useCallback(() => {
    disconnect();
    resetLogs();
    navigate("/yolo-claude");
  }, [disconnect, resetLogs, navigate]);

  // Copy log content to clipboard
  const handleCopyLogs = useCallback(async () => {
    if (logs.length === 0) {
      toast.error("No logs to copy");
      return;
    }

    const logText = logs
      .map((log) => {
        const timestamp = format(log.timestamp, "HH:mm:ss");
        const level = log.level.toUpperCase().padEnd(5);
        return `[${timestamp}] ${level} ${log.message}`;
      })
      .join("\n");

    try {
      await navigator.clipboard.writeText(logText);
      toast.success("Logs copied to clipboard");
    } catch {
      toast.error("Failed to copy logs to clipboard");
    }
  }, [logs]);

  // Get status badge variant and icon
  const getStatusDisplay = (currentStatus: JobStatus) => {
    switch (currentStatus) {
      case JobStatus.PENDING:
        return {
          variant: "secondary" as const,
          icon: <Clock className="h-4 w-4" />,
          label: "Pending",
        };
      case JobStatus.IN_PROGRESS:
        return {
          variant: "default" as const,
          icon: <Play className="h-4 w-4" />,
          label: "Running",
        };
      case JobStatus.COMPLETED:
        return {
          variant: "default" as const,
          icon: <CheckCircle className="h-4 w-4" />,
          label: "Completed",
          className: "bg-green-500 hover:bg-green-600",
        };
      case JobStatus.FAILED:
        return {
          variant: "destructive" as const,
          icon: <XCircle className="h-4 w-4" />,
          label: "Failed",
        };
      case JobStatus.CANCELLED:
        return {
          variant: "secondary" as const,
          icon: <Square className="h-4 w-4" />,
          label: "Cancelled",
        };
      default:
        return {
          variant: "secondary" as const,
          icon: <AlertCircle className="h-4 w-4" />,
          label: "Unknown",
        };
    }
  };

  // Get log level styling
  const getLogLevelStyle = (level: JobLog["level"]) => {
    switch (level) {
      case "error":
        return "text-red-400";
      case "warning":
        return "text-yellow-400";
      case "debug":
        return "text-gray-500";
      case "info":
      default:
        return "text-green-400";
    }
  };

  if (!jobId) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Invalid job ID provided.</AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  if (isLoadingJob) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6 flex items-center justify-center min-h-[200px]">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Loading job details...</span>
          </div>
        </div>
      </div>
    );
  }

  if (jobError || !jobDetails) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load job details: {jobError?.message || "Unknown error"}
            </AlertDescription>
          </Alert>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" onClick={handleGoBack}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Go Back
            </Button>
            <Button onClick={() => refetchJob()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const statusDisplay = getStatusDisplay(status);

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={handleGoBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="p-3 rounded-md bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300">
              <Terminal className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Job Execution</h1>
              <p className="text-muted-foreground">
                Real-time monitoring of Claude Code execution
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isConnected ? (
              <Badge variant="outline" className="text-green-600">
                <Wifi className="h-3 w-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="outline" className="text-red-600">
                <WifiOff className="h-3 w-3 mr-1" />
                Disconnected
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl mx-auto w-full space-y-6">
        {/* Job Information Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  Job #{jobDetails.id.slice(-8)}
                  <Badge
                    variant={statusDisplay.variant}
                    className={cn(statusDisplay.className)}
                  >
                    {statusDisplay.icon}
                    <span className="ml-1">{statusDisplay.label}</span>
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Created{" "}
                  {formatDistanceToNow(new Date(jobDetails.createdAt), {
                    addSuffix: true,
                  })}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    window.open(jobDetails.repositoryUrl, "_blank")
                  }
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium text-muted-foreground">
                  Repository
                </div>
                <div className="text-sm font-mono bg-muted px-2 py-1 rounded mt-1">
                  {jobDetails.repositoryUrl.replace(/^https?:\/\/(www\.)?/, "")}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">
                  Story File
                </div>
                <div className="text-sm font-mono bg-muted px-2 py-1 rounded mt-1">
                  {jobDetails.storyFile}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">
                  Architecture Doc
                </div>
                <div className="text-sm font-mono bg-muted px-2 py-1 rounded mt-1">
                  {jobDetails.architectureDoc}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">
                  Branch Prefix
                </div>
                <div className="text-sm font-mono bg-muted px-2 py-1 rounded mt-1">
                  {jobDetails.branchPrefix || "story"}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Progress Card */}
        {(status === JobStatus.IN_PROGRESS || progress) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <Progress
                  value={progress?.percentage || 0}
                  className="w-full h-2"
                />
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">
                    {progress?.percentage || 0}% Complete
                  </span>
                  {progress?.current !== undefined &&
                    progress?.total !== undefined && (
                      <span className="text-muted-foreground">
                        {progress.current} / {progress.total}
                      </span>
                    )}
                </div>
                {progress?.message && (
                  <div className="text-sm text-muted-foreground">
                    {progress.message}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Error Display */}
        {(sseError || status === JobStatus.FAILED) && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>
              {sseError ||
                "Job execution failed. Check the logs below for more details."}
            </AlertDescription>
          </Alert>
        )}

        {/* Log Stream Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5" />
                  Execution Logs
                </CardTitle>
                <CardDescription>
                  Real-time logs from Claude Code execution
                  {logs.length > 0 && ` • ${logs.length} entries`}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyLogs}
                  disabled={logs.length === 0}
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAutoScroll(!autoScroll)}
                >
                  {autoScroll ? "Disable" : "Enable"} Auto-scroll
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div
              className="h-[500px] overflow-auto bg-slate-950 text-slate-100 rounded-md p-4 font-mono text-sm"
              onScroll={handleLogScroll}
            >
              {logs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {status === JobStatus.PENDING ? (
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Waiting for job to start...
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Terminal className="h-4 w-4" />
                      No logs available yet
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {logs.map((log, index) => (
                    <div key={`${log.id}-${index}`} className="flex gap-3 py-1">
                      <span className="text-slate-500 text-xs min-w-[60px]">
                        {format(log.timestamp, "HH:mm:ss")}
                      </span>
                      <span
                        className={cn(
                          "text-xs min-w-[50px] uppercase",
                          getLogLevelStyle(log.level),
                        )}
                      >
                        {log.level}
                      </span>
                      <span className="flex-1 whitespace-pre-wrap">
                        {log.message}
                      </span>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        {isComplete && (
          <div className="flex justify-center gap-4">
            <Button onClick={handleStartNewJob}>
              <Play className="h-4 w-4 mr-2" />
              Start New Job
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
