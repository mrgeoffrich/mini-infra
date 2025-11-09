import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconDatabase,
  IconCalendarEvent,
  IconFolderOpen,
  IconSettings,
  IconPlus,
} from "@tabler/icons-react";
import { usePostgresDatabases } from "@/hooks/use-postgres-databases";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import type { PostgresServerInfo } from "@mini-infra/types";

interface BackupsTabProps {
  server: PostgresServerInfo;
}

export function BackupsTab({ server }: BackupsTabProps) {
  const navigate = useNavigate();
  const { formatRelativeTime } = useFormattedDate();

  // Fetch all PostgresDatabase entries that match this server's host and port
  const {
    data: databasesResponse,
    isLoading,
    error,
  } = usePostgresDatabases({
    filters: {
      host: server.host,
    },
  });

  const databases = databasesResponse?.data || [];

  // Filter to only show databases that match this server's port as well
  const matchingDatabases = databases.filter((db) => db.port === server.port);

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <Skeleton className="h-6 w-32 mb-2" />
                <Skeleton className="h-4 w-64" />
              </div>
              <Skeleton className="h-10 w-48" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-destructive py-6">
              <p className="text-sm">Failed to load backup configurations</p>
              <p className="text-xs mt-1">{error.message}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Empty state
  if (matchingDatabases.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Database Backups</CardTitle>
                <CardDescription>
                  Configure automated backups for databases on this server
                </CardDescription>
              </div>
              <Button onClick={() => navigate("/postgres-backup")}>
                <IconPlus className="h-4 w-4 mr-2" />
                Configure First Backup
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="p-4 rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300 mb-4">
                <IconDatabase className="h-12 w-12" />
              </div>
              <h3 className="text-lg font-semibold mb-2">
                No backups configured
              </h3>
              <p className="text-muted-foreground mb-4 max-w-sm">
                Set up automated backups for databases on {server.host}:{server.port} to protect your data
              </p>
              <Button onClick={() => navigate("/postgres-backup")}>
                <IconPlus className="h-4 w-4 mr-2" />
                Configure Backup
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Database list view with backup configurations
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Database Backups</CardTitle>
              <CardDescription>
                Backup configurations for databases on this server
              </CardDescription>
            </div>
            <Button onClick={() => navigate("/postgres-backup")}>
              <IconPlus className="h-4 w-4 mr-2" />
              Add Backup Configuration
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground mb-4 pb-4 border-b">
            {matchingDatabases.length} backup configuration
            {matchingDatabases.length !== 1 ? "s" : ""}
          </div>

          {/* Database Backup List */}
          <div className="space-y-3">
            {matchingDatabases.map((db) => (
              <div
                key={db.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start gap-3 flex-1">
                  <IconDatabase className="h-5 w-5 text-blue-600 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-semibold text-sm">{db.name}</h4>
                      <Badge
                        variant={
                          db.healthStatus === "healthy"
                            ? "default"
                            : db.healthStatus === "unhealthy"
                              ? "destructive"
                              : "secondary"
                        }
                        className="text-xs"
                      >
                        {db.healthStatus}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <div>
                        <span className="font-medium">Database:</span>{" "}
                        {db.database}
                      </div>
                      {db.lastHealthCheck && (
                        <div>
                          <span className="font-medium">Last checked:</span>{" "}
                          {formatRelativeTime(db.lastHealthCheck)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      navigate(`/postgres-backup/${db.id}/restore`)
                    }
                  >
                    <IconFolderOpen className="h-4 w-4 mr-1" />
                    Browse Backups
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate("/postgres-backup")}
                  >
                    <IconSettings className="h-4 w-4 mr-1" />
                    Configure
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Help Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <IconCalendarEvent className="h-4 w-4" />
            About Database Backups
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              Database backups are stored in Azure Blob Storage and can be
              configured with automated schedules.
            </p>
            <p>
              To add a backup configuration for a database on this server, use
              the "Add Backup Configuration" button above or visit the{" "}
              <button
                onClick={() => navigate("/postgres-backup")}
                className="text-primary hover:underline"
              >
                PostgreSQL Backups
              </button>{" "}
              page.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
