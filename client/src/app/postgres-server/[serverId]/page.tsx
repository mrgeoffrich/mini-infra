import { useParams, useNavigate, Link } from "react-router-dom";
import { useState } from "react";
import {
  IconDatabase,
  IconRefresh,
  IconEdit,
  IconDots,
  IconSettingsQuestion,
  IconTrash,
  IconDashboard,
  IconUser,
  IconArchive,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OverviewTab } from "@/components/postgres-server/overview-tab";
import { DatabasesTab } from "@/components/postgres-server/databases-tab";
import { UsersTab } from "@/components/postgres-server/users-tab";
import { BackupsTab } from "@/components/postgres-server/backups-tab";
import { HealthStatusBadge } from "@/components/postgres-server/health-status-badge";
import { ServerModal } from "@/components/postgres-server/server-modal";
import { usePostgresServer } from "@/hooks/use-postgres-servers";
import { useManagedDatabaseUsers } from "@/hooks/use-managed-database-users";
import { useManagedDatabases } from "@/hooks/use-managed-databases";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export default function PostgresServerDetailsPage() {
  const { serverId } = useParams<{ serverId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("overview");
  const [editModalOpen, setEditModalOpen] = useState(false);

  const { data: response, isLoading, error } = usePostgresServer(serverId!);
  const server = response?.data;

  // Fetch users for the database modal and grants management
  const { data: usersResponse } = useManagedDatabaseUsers(serverId);
  const availableUsers = usersResponse?.data || [];

  // Fetch databases for the grants management
  const { data: databasesResponse } = useManagedDatabases(serverId);
  const availableDatabases = databasesResponse?.data || [];

  const handleSync = async () => {
    toast.promise(
      fetch(`/api/postgres-servers/${serverId}/sync`, {
        method: "POST",
        credentials: "include",
      }).then((res) => {
        if (!res.ok) throw new Error("Failed to sync server");
        return res.json();
      }),
      {
        loading: "Syncing server data...",
        success: "Server synced successfully",
        error: "Failed to sync server",
      }
    );
  };

  const handleEdit = () => {
    setEditModalOpen(true);
  };

  const handleTestConnection = async () => {
    toast.promise(
      fetch(`/api/postgres-servers/${serverId}/test-connection`, {
        method: "POST",
        credentials: "include",
      }).then((res) => {
        if (!res.ok) throw new Error("Connection test failed");
        return res.json();
      }),
      {
        loading: "Testing connection...",
        success: "Connection successful",
        error: "Connection failed",
      }
    );
  };

  const handleDelete = async () => {
    if (
      !confirm(
        "Are you sure you want to delete this server? This will not affect the actual PostgreSQL server, only the connection information."
      )
    ) {
      return;
    }

    try {
      const res = await fetch(`/api/postgres-servers/${serverId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) throw new Error("Failed to delete server");

      toast.success("Server deleted successfully");
      navigate("/postgres-server");
    } catch {
      toast.error("Failed to delete server");
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-8 w-64 mb-4" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    );
  }

  if (error || !server) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="text-center py-12">
            <h2 className="text-2xl font-bold mb-2">Server not found</h2>
            <p className="text-muted-foreground mb-4">
              The server you're looking for doesn't exist or has been deleted.
            </p>
            <Button onClick={() => navigate("/postgres-server")}>
              Back to Servers
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Breadcrumb Navigation */}
      <div className="px-4 lg:px-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/postgres-server" className="flex items-center gap-2">
                  <IconDatabase className="h-4 w-4" />
                  PostgreSQL Servers
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{server.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconDatabase className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-bold">{server.name}</h1>
                <HealthStatusBadge status={server.healthStatus} />
              </div>
              <p className="text-muted-foreground">
                {server.host}:{server.port}
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleSync}>
              <IconRefresh className="h-4 w-4 mr-2" />
              Sync from Server
            </Button>
            <Button variant="outline" onClick={handleEdit}>
              <IconEdit className="h-4 w-4 mr-2" />
              Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <IconDots className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleTestConnection}>
                  <IconSettingsQuestion className="h-4 w-4 mr-2" />
                  Test Connection
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleDelete}
                  className="text-destructive"
                >
                  <IconTrash className="h-4 w-4 mr-2" />
                  Delete Server
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 lg:px-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-4 lg:w-auto lg:inline-grid">
            <TabsTrigger value="overview">
              <IconDashboard className="h-4 w-4 mr-2" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="databases">
              <IconDatabase className="h-4 w-4 mr-2" />
              Databases
            </TabsTrigger>
            <TabsTrigger value="users">
              <IconUser className="h-4 w-4 mr-2" />
              Users
            </TabsTrigger>
            <TabsTrigger value="backups">
              <IconArchive className="h-4 w-4 mr-2" />
              Backups
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab server={server} onChangeTab={setActiveTab} />
          </TabsContent>

          <TabsContent value="databases">
            <DatabasesTab
              serverId={serverId!}
              serverName={server.name}
              availableUsers={availableUsers}
              serverHost={server.host}
              serverPort={server.port}
            />
          </TabsContent>

          <TabsContent value="users">
            <UsersTab serverId={serverId!} availableDatabases={availableDatabases} />
          </TabsContent>

          <TabsContent value="backups">
            <BackupsTab server={server} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Edit Server Modal */}
      <ServerModal
        open={editModalOpen}
        onOpenChange={setEditModalOpen}
        mode="edit"
        serverId={serverId}
        serverData={server}
      />
    </div>
  );
}
