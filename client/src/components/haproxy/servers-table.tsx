import {
  IconRefresh,
  IconAlertCircle,
  IconServer,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useBackendServers } from "@/hooks/use-haproxy-backends";
import { HAProxyServerInfo } from "@mini-infra/types";
import { ServerRow } from "./server-row";

interface ServersTableProps {
  backendName: string;
  environmentId: string;
}

export function ServersTable({ backendName, environmentId }: ServersTableProps) {
  const {
    data: serversResponse,
    isLoading,
    error,
    refetch,
  } = useBackendServers(backendName, environmentId, {
    refetchInterval: 30000,
  });

  const servers = serversResponse?.data || [];

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconServer className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Servers</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconServer className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Servers</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {error instanceof Error ? error.message : "Failed to load servers"}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconServer className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Servers ({servers.length})</CardTitle>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <IconRefresh className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {servers.length === 0 ? (
          <div className="text-center py-8">
            <IconServer className="mx-auto h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-semibold">No servers configured</h3>
            <p className="mt-2 text-muted-foreground">
              Servers are added automatically when deployments are created.
            </p>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server Name</TableHead>
                  <TableHead>Address:Port</TableHead>
                  <TableHead>Weight</TableHead>
                  <TableHead>Health Check</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Maintenance</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server: HAProxyServerInfo) => (
                  <ServerRow
                    key={server.id}
                    server={server}
                    backendName={backendName}
                    environmentId={environmentId}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
