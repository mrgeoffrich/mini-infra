import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  IconAlertCircle,
  IconExternalLink,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { formatRelativeTime } from "@/lib/date-utils";
import { useGitHubAppActionRuns } from "@/hooks/use-github-app";
import type { GitHubAppRepository, GitHubAppActionsRun } from "@mini-infra/types";

function getRunStatusColor(
  status: string,
  conclusion: string | null,
): { className: string; label: string } {
  if (status === "completed") {
    switch (conclusion) {
      case "success":
        return {
          className:
            "bg-green-100 text-green-800 border-green-200 hover:bg-green-100",
          label: "Success",
        };
      case "failure":
        return {
          className:
            "bg-red-100 text-red-800 border-red-200 hover:bg-red-100",
          label: "Failure",
        };
      case "cancelled":
        return {
          className:
            "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-100",
          label: "Cancelled",
        };
      case "skipped":
        return {
          className:
            "bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-100",
          label: "Skipped",
        };
      case "timed_out":
        return {
          className:
            "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-100",
          label: "Timed Out",
        };
      default:
        return {
          className:
            "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-100",
          label: conclusion || "Unknown",
        };
    }
  }

  if (status === "in_progress") {
    return {
      className:
        "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-100",
      label: "In Progress",
    };
  }

  if (status === "queued") {
    return {
      className:
        "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100",
      label: "Queued",
    };
  }

  if (status === "waiting") {
    return {
      className:
        "bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-100",
      label: "Waiting",
    };
  }

  return {
    className:
      "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-100",
    label: status,
  };
}

interface ActionsTabProps {
  isConnected: boolean;
  repositories?: GitHubAppRepository[];
}

export function ActionsTab({ isConnected, repositories }: ActionsTabProps) {
  const [selectedRepo, setSelectedRepo] = useState<string>("");

  // Parse owner/repo from the selected full name
  const [repoOwner, repoName] = selectedRepo
    ? selectedRepo.split("/")
    : ["", ""];

  const {
    data: runs,
    isLoading,
    error,
  } = useGitHubAppActionRuns(
    repoOwner,
    repoName,
    isConnected && !!selectedRepo,
  );

  // Filter repos that have actions enabled
  const actionsRepos = repositories?.filter((r) => r.hasActions) || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Repository:</label>
        <Select value={selectedRepo} onValueChange={setSelectedRepo}>
          <SelectTrigger className="w-[300px]">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {actionsRepos.length === 0 && repositories && repositories.length > 0 ? (
              // Show all repos if none have hasActions flag
              repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </SelectItem>
              ))
            ) : actionsRepos.length > 0 ? (
              actionsRepos.map((repo) => (
                <SelectItem key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </SelectItem>
              ))
            ) : (
              <SelectItem value="__none__" disabled>
                No repositories available
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      {!selectedRepo && (
        <div className="text-center py-8 text-muted-foreground">
          <IconPlayerPlay className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p>Select a repository to view workflow runs</p>
        </div>
      )}

      {selectedRepo && isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {selectedRepo && error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load action runs: {error.message}
          </AlertDescription>
        </Alert>
      )}

      {selectedRepo && !isLoading && !error && runs && runs.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <IconPlayerPlay className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p>No workflow runs found for this repository</p>
        </div>
      )}

      {selectedRepo && !isLoading && !error && runs && runs.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Run #</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run: GitHubAppActionsRun) => {
              const statusInfo = getRunStatusColor(
                run.status,
                run.conclusion,
              );
              return (
                <TableRow key={run.id}>
                  <TableCell className="font-medium">
                    {run.workflowName}
                  </TableCell>
                  <TableCell>
                    <Badge className={statusInfo.className}>
                      {statusInfo.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {run.headBranch}
                    </code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    #{run.runNumber}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{run.event}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatRelativeTime(run.createdAt)}
                  </TableCell>
                  <TableCell>
                    <a
                      href={run.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex"
                    >
                      <IconExternalLink className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
                    </a>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
