import { useState } from "react";
import { IconDatabase, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerModal } from "@/components/postgres-server/server-modal";
import { usePostgresServers } from "@/hooks/use-postgres-servers";

export function PostgresServerPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");

  // Fetch servers using React Query
  const { data, isLoading } = usePostgresServers();
  const servers = data?.data || [];

  const handleOpenDialog = (mode: "create" | "edit") => {
    setModalMode(mode);
    setModalOpen(true);
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header with Action Button */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          {/* Left: Icon + Title */}
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconDatabase className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">PostgreSQL Servers</h1>
              <p className="text-muted-foreground">
                Manage PostgreSQL server connections, databases, and users
              </p>
            </div>
          </div>

          {/* Right: Add Server Button */}
          <Button onClick={() => handleOpenDialog("create")}>
            <IconPlus className="h-4 w-4 mr-2" />
            Add Server
          </Button>
        </div>
      </div>

      {/* Server List Section */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Connected Servers</CardTitle>
            <CardDescription>
              PostgreSQL servers you have access to manage
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3].map((i) => (
                  <Card key={i}>
                    <CardHeader>
                      <Skeleton className="h-6 w-32 mb-2" />
                      <Skeleton className="h-4 w-48" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-24 w-full" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : servers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="p-4 rounded-full bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300 mb-4">
                  <IconDatabase className="h-12 w-12" />
                </div>
                <h3 className="text-lg font-semibold mb-2">No PostgreSQL Servers</h3>
                <p className="text-muted-foreground mb-4 max-w-sm">
                  Connect to your first PostgreSQL server to start managing databases and users
                </p>
                <Button onClick={() => handleOpenDialog("create")}>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Add Your First Server
                </Button>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {servers.map((server) => (
                  <Card key={server.id} className="hover:shadow-md transition-shadow cursor-pointer">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-lg">{server.name}</CardTitle>
                          <CardDescription className="mt-1">
                            {server.host}:{server.port}
                          </CardDescription>
                        </div>
                        <div className={`px-2 py-1 rounded text-xs font-medium ${
                          server.healthStatus === 'healthy'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                            : server.healthStatus === 'unhealthy'
                            ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'
                            : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
                        }`}>
                          {server.healthStatus}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Databases:</span>
                          <span className="font-medium">{server._count.databases}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Users:</span>
                          <span className="font-medium">{server._count.users}</span>
                        </div>
                        {server.serverVersion && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Version:</span>
                            <span className="font-medium">{server.serverVersion}</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">SSL Mode:</span>
                          <span className="font-medium">{server.sslMode}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Server Modal */}
      <ServerModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        mode={modalMode}
      />
    </div>
  );
}

export default PostgresServerPage;
