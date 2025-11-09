import { PostgresServerInfo } from "@mini-infra/types";
import {
  IconDatabase,
  IconUser,
  IconShield,
  IconHistory,
  IconRefresh,
} from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HealthStatusBadge } from "./health-status-badge";
import { formatRelativeTime } from "@/lib/date-utils";

interface OverviewTabProps {
  server: PostgresServerInfo;
  onChangeTab: (tab: string) => void;
}

function calculateTotalGrants(_server: PostgresServerInfo): number {
  // TODO: Calculate from actual grant data when available
  return 0;
}

export function OverviewTab({ server, onChangeTab }: OverviewTabProps) {
  const handleTestConnection = async () => {
    // TODO: Implement test connection
    console.log("Test connection");
  };

  return (
    <div className="space-y-4">
      {/* Server Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>Server Information</CardTitle>
          <CardDescription>Connection details and status</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Connection Info */}
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Host</Label>
              <div className="font-mono text-sm">
                {server.host}:{server.port}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">
                Admin Username
              </Label>
              <div className="font-mono text-sm">{server.adminUsername}</div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">SSL Mode</Label>
              <div className="font-mono text-sm">{server.sslMode}</div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">
                Server Version
              </Label>
              <div className="font-mono text-sm">
                {server.serverVersion || "Unknown"}
              </div>
            </div>
          </div>

          {/* Health Status */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-sm text-muted-foreground">
                  Health Status
                </Label>
                <div className="flex items-center gap-2">
                  <HealthStatusBadge status={server.healthStatus} />
                  {server.lastHealthCheck && (
                    <span className="text-xs text-muted-foreground">
                      Last checked {formatRelativeTime(server.lastHealthCheck)}
                    </span>
                  )}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleTestConnection}>
                <IconRefresh className="h-4 w-4 mr-2" />
                Check Now
              </Button>
            </div>
          </div>

          {/* Tags */}
          {server.tags && Array.isArray(server.tags) && server.tags.length > 0 && (
            <div className="border-t pt-4">
              <Label className="text-sm text-muted-foreground mb-2 block">
                Tags
              </Label>
              <div className="flex flex-wrap gap-2">
                {server.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Statistics Card */}
      <Card>
        <CardHeader>
          <CardTitle>Resource Summary</CardTitle>
          <CardDescription>
            Databases, users, and grants on this server
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Databases */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <IconDatabase className="h-4 w-4" />
                <span className="text-sm">Databases</span>
              </div>
              <div className="text-3xl font-bold text-purple-600">
                {server._count?.databases || 0}
              </div>
              <Button
                variant="link"
                className="p-0 h-auto"
                onClick={() => onChangeTab("databases")}
              >
                View all databases →
              </Button>
            </div>

            {/* Users */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <IconUser className="h-4 w-4" />
                <span className="text-sm">Users</span>
              </div>
              <div className="text-3xl font-bold text-blue-600">
                {server._count?.users || 0}
              </div>
              <Button
                variant="link"
                className="p-0 h-auto"
                onClick={() => onChangeTab("users")}
              >
                View all users →
              </Button>
            </div>

            {/* Total Grants */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <IconShield className="h-4 w-4" />
                <span className="text-sm">Active Grants</span>
              </div>
              <div className="text-3xl font-bold text-green-600">
                {calculateTotalGrants(server)}
              </div>
              <div className="text-sm text-muted-foreground">
                Permission assignments
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Activity Card */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest changes and operations</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Activity feed or "No recent activity" message */}
          <div className="text-center text-muted-foreground py-6">
            <IconHistory className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No recent activity</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
