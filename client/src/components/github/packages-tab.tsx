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
  IconLock,
  IconPackage,
} from "@tabler/icons-react";
import { formatRelativeTime } from "@/lib/date-utils";
import { useGitHubAppPackages } from "@/hooks/use-github-app";
import type { GitHubAppPackage } from "@mini-infra/types";

interface PackagesTabProps {
  isConnected: boolean;
}

export function PackagesTab({ isConnected }: PackagesTabProps) {
  const {
    data: packages,
    isLoading,
    error,
  } = useGitHubAppPackages(isConnected);

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
          Failed to load packages: {error.message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!packages || packages.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <IconPackage className="h-12 w-12 mx-auto mb-3 opacity-40" />
        <p>No packages found</p>
        <p className="text-sm mt-1">
          Packages will appear here once published to your GitHub account.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Visibility</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {packages.map((pkg: GitHubAppPackage) => (
          <TableRow key={pkg.id}>
            <TableCell className="font-medium">{pkg.name}</TableCell>
            <TableCell>
              <Badge variant="secondary">{pkg.packageType}</Badge>
            </TableCell>
            <TableCell>
              {pkg.visibility === "private" ? (
                <Badge variant="outline" className="gap-1">
                  <IconLock className="h-3 w-3" />
                  Private
                </Badge>
              ) : (
                <Badge variant="secondary">{pkg.visibility}</Badge>
              )}
            </TableCell>
            <TableCell>{pkg.owner}</TableCell>
            <TableCell className="text-muted-foreground">
              {formatRelativeTime(pkg.updatedAt)}
            </TableCell>
            <TableCell>
              <a
                href={pkg.htmlUrl}
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
