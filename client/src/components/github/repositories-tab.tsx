import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  IconGitBranch,
  IconLock,
} from "@tabler/icons-react";
import { formatRelativeTime } from "@/lib/date-utils";
import { useGitHubAppRepositories } from "@/hooks/use-github-app";
import type { GitHubAppRepository } from "@mini-infra/types";

interface RepositoriesTabProps {
  isConnected: boolean;
}

export function RepositoriesTab({ isConnected }: RepositoriesTabProps) {
  const {
    data: repos,
    isLoading,
    error,
  } = useGitHubAppRepositories(isConnected);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load repositories: {error.message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <IconGitBranch className="h-12 w-12 mx-auto mb-3 opacity-40" />
        <p>No repositories found</p>
        <p className="text-sm mt-1">
          Repositories accessible by the GitHub App will appear here.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Language</TableHead>
          <TableHead>Visibility</TableHead>
          <TableHead>Default Branch</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {repos.map((repo: GitHubAppRepository) => (
          <TableRow key={repo.id}>
            <TableCell className="font-medium">{repo.name}</TableCell>
            <TableCell
              className="max-w-[200px] truncate text-muted-foreground"
              title={repo.description || undefined}
            >
              {repo.description || "-"}
            </TableCell>
            <TableCell>
              {repo.language ? (
                <Badge variant="secondary">{repo.language}</Badge>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </TableCell>
            <TableCell>
              {repo.private ? (
                <Badge variant="outline" className="gap-1">
                  <IconLock className="h-3 w-3" />
                  Private
                </Badge>
              ) : (
                <Badge variant="secondary">Public</Badge>
              )}
            </TableCell>
            <TableCell>
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                {repo.defaultBranch}
              </code>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatRelativeTime(repo.updatedAt)}
            </TableCell>
            <TableCell>
              <a
                href={repo.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
              >
                <IconExternalLink className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
