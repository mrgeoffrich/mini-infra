import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { IconDatabase, IconArrowLeft } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import { TableList } from "@/components/postgres-server/table-list";
import { TableDataGrid } from "@/components/postgres-server/table-data-grid";
import { useManagedDatabase } from "@/hooks/use-managed-databases";
import { usePostgresServer } from "@/hooks/use-postgres-servers";
import { useDatabaseTables } from "@/hooks/use-table-data";

export default function DatabaseDetailPage() {
  const { serverId, dbId } = useParams<{ serverId: string; dbId: string }>();
  const navigate = useNavigate();
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  // Fetch server data
  const { data: serverResponse, isLoading: isServerLoading } = usePostgresServer(serverId);
  const server = serverResponse?.data;

  // Fetch database data
  const { data: databaseResponse, isLoading: isDatabaseLoading } = useManagedDatabase(
    serverId,
    dbId
  );
  const database = databaseResponse?.data;

  // Fetch tables
  const {
    data: tablesResponse,
    isLoading: isTablesLoading,
    refetch: refetchTables,
  } = useDatabaseTables(serverId, dbId);
  const tables = tablesResponse?.data || [];

  const isLoading = isServerLoading || isDatabaseLoading;

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

  if (!server || !database) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="text-center py-12">
            <h2 className="text-2xl font-bold mb-2">Database not found</h2>
            <p className="text-muted-foreground mb-4">
              The database you're looking for doesn't exist or has been deleted.
            </p>
            <Button onClick={() => navigate(`/postgres-server/${serverId}`)}>
              Back to Server
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 border-b">
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
                <BreadcrumbLink asChild>
                  <Link to={`/postgres-server/${serverId}`}>{server.name}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Databases</BreadcrumbPage>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{database.databaseName}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        {/* Database Header */}
        <div className="px-4 lg:px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigate(`/postgres-server/${serverId}`)}
              >
                <IconArrowLeft className="h-4 w-4" />
              </Button>
              <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
                <IconDatabase className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">{database.databaseName}</h1>
                <p className="text-muted-foreground">
                  {server.name} • Owner: {database.owner}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {database.sizeBytes && (
                <div className="text-sm text-muted-foreground">
                  Size: {(database.sizeBytes / 1024 / 1024).toFixed(2)} MB
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content - Side by Side Layout */}
      <div className="flex-1 overflow-hidden">
        <div className="grid grid-cols-12 h-full">
          {/* Left Panel - Table List */}
          <div className="col-span-12 md:col-span-4 lg:col-span-3 border-r h-full overflow-hidden">
            <TableList
              tables={tables}
              isLoading={isTablesLoading}
              selectedTable={selectedTable}
              onSelectTable={setSelectedTable}
              onRefresh={refetchTables}
            />
          </div>

          {/* Right Panel - Table Data Grid */}
          <div className="col-span-12 md:col-span-8 lg:col-span-9 h-full overflow-hidden">
            <TableDataGrid
              serverId={serverId!}
              databaseId={dbId!}
              tableName={selectedTable}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
