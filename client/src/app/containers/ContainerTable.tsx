import React from "react";
import { useNavigate } from "react-router";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  Cell,
} from "@tanstack/react-table";
import { useDataTable } from "@/lib/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ContainerInfo } from "@mini-infra/types";
import { ContainerStatusBadge } from "./ContainerStatusBadge";
import { IconArrowsSort, IconDatabasePlus, IconDatabase } from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ServerModal } from "@/components/postgres-server/server-modal";
import { toast } from "sonner";

interface ContainerTableProps {
  containers: ContainerInfo[];
  isLoading: boolean;
  postgresContainerIds?: Set<string>;
  managedContainerIds?: Set<string>;
  managedContainerMap?: Record<string, string>; // container ID -> server ID
}

const SELF_ROLE_LABELS: Record<string, string> = {
  main: "Mini Infra",
  "agent-sidecar": "Agent Sidecar",
  "update-sidecar": "Update Sidecar",
};

const ContainerNameCell = React.memo(
  ({
    name,
    selfRole,
    postgresAction,
    onPostgresAction,
    isPoolInstance,
  }: {
    name: string;
    selfRole?: string;
    postgresAction?: "add" | "manage";
    onPostgresAction?: () => void;
    isPoolInstance?: boolean;
  }) => (
    <div className="flex items-center gap-2 min-h-[2rem]">
      <span className="font-medium truncate">{name}</span>
      {selfRole && SELF_ROLE_LABELS[selfRole] && (
        <span className="shrink-0 text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-1.5 py-0.5 rounded">
          {SELF_ROLE_LABELS[selfRole]}
        </span>
      )}
      {isPoolInstance && (
        <span className="shrink-0 text-xs bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded">
          Pool
        </span>
      )}
      {postgresAction && onPostgresAction && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPostgresAction();
              }}
              className="shrink-0 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              {postgresAction === "add" ? (
                <IconDatabasePlus className="h-4 w-4" />
              ) : (
                <IconDatabase className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {postgresAction === "add"
              ? "Register as PostgreSQL server"
              : "Manage PostgreSQL server"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  ),
  (prevProps, nextProps) =>
    prevProps.name === nextProps.name &&
    prevProps.selfRole === nextProps.selfRole &&
    prevProps.postgresAction === nextProps.postgresAction &&
    prevProps.isPoolInstance === nextProps.isPoolInstance,
);

ContainerNameCell.displayName = "ContainerNameCell";

const ContainerImageCell = React.memo(
  ({ image, imageTag }: { image: string; imageTag: string }) => {
    const fullImage = React.useMemo(
      () => `${image}:${imageTag}`,
      [image, imageTag],
    );
    return (
      <div className="max-w-xs">
        <div className="font-mono text-sm truncate" title={fullImage}>
          {image}
        </div>
        <div className="text-xs text-muted-foreground">{imageTag}</div>
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.image === nextProps.image &&
    prevProps.imageTag === nextProps.imageTag,
);

ContainerImageCell.displayName = "ContainerImageCell";


const ContainerRow = React.memo(
  ({
    container,
    visibleCells,
    getColumnWidth,
    onRowClick,
  }: {
    container: ContainerInfo;
    visibleCells: Cell<ContainerInfo, unknown>[];
    getColumnWidth: (index: number) => string;
    onRowClick: (containerId: string) => void;
  }) => {
    const handleClick = React.useCallback(
      (e: React.MouseEvent) => {
        // Prevent navigation if clicking on interactive elements
        const target = e.target as HTMLElement;
        if (
          target.closest("button") ||
          target.closest("a") ||
          target.closest("[role='button']")
        ) {
          return;
        }
        onRowClick(container.id);
      },
      [container.id, onRowClick],
    );

    return (
      <TableRow
        key={container.id}
        className="hover:bg-muted/50 h-16 cursor-pointer"
        onClick={handleClick}
      >
        {visibleCells.map((cell, index) => (
          <TableCell
            key={cell.id}
            className={`px-6 py-4 ${getColumnWidth(index)} align-middle`}
            style={{ height: "4rem" }}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        ))}
      </TableRow>
    );
  },
  (prevProps, nextProps) => {
    // Only re-render if container data actually changed
    const prev = prevProps.container;
    const next = nextProps.container;

    return (
      prev.id === next.id &&
      prev.name === next.name &&
      prev.status === next.status &&
      prev.image === next.image &&
      prev.imageTag === next.imageTag
    );
  },
);

ContainerRow.displayName = "ContainerRow";

export const ContainerTable = React.memo(function ContainerTable({
  containers,
  isLoading,
  postgresContainerIds,
  managedContainerIds,
  managedContainerMap,
}: ContainerTableProps) {
  const [sortBy, setSortBy] = React.useState("name");
  const [sortOrder, setSortOrder] = React.useState<"asc" | "desc">("asc");
  const updateSort = React.useCallback((field: string) => {
    setSortBy((prev) => {
      if (prev === field) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      } else {
        setSortOrder("asc");
      }
      return field;
    });
  }, []);
  const navigate = useNavigate();

  // Modal state for adding postgres servers
  const [isServerModalOpen, setIsServerModalOpen] = React.useState(false);
  const [, setSelectedContainer] = React.useState<ContainerInfo | null>(null);
  const [initialServerValues, setInitialServerValues] = React.useState<Record<string, unknown> | null>(null);
  // Function to fetch container environment variables and docker host
  const handleAddPostgresServer = React.useCallback(async (container: ContainerInfo) => {
    setSelectedContainer(container);

    try {
      // Fetch environment variables and docker host in parallel
      const [envResponse, dockerHostResponse] = await Promise.all([
        fetch(`/api/containers/${container.id}/env`).then(r => r.json()),
        fetch('/api/settings/docker-host').then(r => r.json()),
      ]);

      // Extract postgres-related environment variables
      const envVars = envResponse.success ? envResponse.data : {};
      const dockerHost = dockerHostResponse.success ? dockerHostResponse.data.host : 'localhost';

      // Find the postgres port (default 5432)
      const postgresPort = container.ports.find(p => p.private === 5432);
      const port = postgresPort?.public || postgresPort?.private || 5432;

      // Prepare initial values for the modal
      const initialValues = {
        name: container.name,
        host: dockerHost,
        port: port,
        adminUsername: envVars.POSTGRES_USER || 'postgres',
        adminPassword: envVars.POSTGRES_PASSWORD || '',
        sslMode: 'prefer' as const,
        linkedContainerId: container.id,
        linkedContainerName: container.name,
      };

      setInitialServerValues(initialValues);
      setIsServerModalOpen(true);
    } catch (error) {
      console.error('Failed to fetch container data:', error);
      toast.error('Failed to load container details. Please try again.');
    }
  }, []);

  // Handle modal close
  const handleServerModalClose = React.useCallback((open: boolean) => {
    setIsServerModalOpen(open);
    if (!open) {
      setSelectedContainer(null);
      setInitialServerValues(null);
    }
  }, []);

  // All hooks must be declared at the top before any conditional returns
  const handleNameSort = React.useCallback(
    () => updateSort("name"),
    [updateSort],
  );
  const handleStatusSort = React.useCallback(
    () => updateSort("status"),
    [updateSort],
  );
  const handleImageSort = React.useCallback(
    () => updateSort("image"),
    [updateSort],
  );
  const handleRowClick = React.useCallback(
    (containerId: string) => {
      navigate(`/containers/${containerId}`);
    },
    [navigate],
  );

  const columns: ColumnDef<ContainerInfo>[] = React.useMemo(
    () => [
      {
        accessorKey: "name",
        header: () => (
          <Button
            variant="ghost"
            onClick={handleNameSort}
            className="h-auto p-0 font-medium"
          >
            Container Name
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => {
          const container = row.original;
          const isPostgres = postgresContainerIds?.has(container.id);
          const isManaged = managedContainerIds?.has(container.id);
          const serverId = managedContainerMap?.[container.id];

          let postgresAction: "add" | "manage" | undefined;
          let onPostgresAction: (() => void) | undefined;

          if (isPostgres && !isManaged) {
            postgresAction = "add";
            onPostgresAction = () => handleAddPostgresServer(container);
          } else if (isPostgres && isManaged && serverId) {
            postgresAction = "manage";
            onPostgresAction = () => navigate(`/postgres-server/${serverId}`);
          }

          const isPoolInstance = container.labels?.["mini-infra.pool-instance"] === "true";

          return (
            <ContainerNameCell
              name={row.getValue("name")}
              selfRole={container.selfRole}
              postgresAction={postgresAction}
              onPostgresAction={onPostgresAction}
              isPoolInstance={isPoolInstance}
            />
          );
        },
      },
      {
        accessorKey: "status",
        header: () => (
          <Button
            variant="ghost"
            onClick={handleStatusSort}
            className="h-auto p-0 font-medium"
          >
            Status
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <ContainerStatusBadge status={row.getValue("status")} />
        ),
      },
      {
        accessorKey: "image",
        header: () => (
          <Button
            variant="ghost"
            onClick={handleImageSort}
            className="h-auto p-0 font-medium"
          >
            Image
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <ContainerImageCell
            image={row.getValue("image")}
            imageTag={row.original.imageTag}
          />
        ),
      },
    ],
    [handleNameSort, handleStatusSort, handleImageSort, postgresContainerIds, managedContainerIds, managedContainerMap, handleAddPostgresServer, navigate],
  );

  const sortingState = React.useMemo(
    () => [{ id: sortBy, desc: sortOrder === "desc" }],
    [sortBy, sortOrder],
  );

  const table = useDataTable({
    data: containers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    getRowId: (row) => row.id, // Use container ID as stable row key
    state: {
      sorting: sortingState,
    },
  });


  // Fixed column widths to prevent layout shifts
  const getColumnWidth = React.useCallback((index: number) => {
    switch (index) {
      case 0:
        return "w-[220px] min-w-[220px] max-w-[220px]"; // Container Name
      case 1:
        return "w-[100px] min-w-[100px] max-w-[100px]"; // Status
      case 2:
        return "w-[240px] min-w-[240px] max-w-[240px]"; // Image
      default:
        return "";
    }
  }, []);

  // Only show skeleton on initial load, not on refresh
  if (isLoading && containers.length === 0) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table className="table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header, index) => (
                  <TableHead
                    key={header.id}
                    className={`px-6 py-3 ${getColumnWidth(index)}`}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {table.getRowModel().rows?.length ? (
              table
                .getRowModel()
                .rows.map((row) => (
                  <ContainerRow
                    key={row.original.id}
                    container={row.original}
                    visibleCells={row.getVisibleCells()}
                    getColumnWidth={getColumnWidth}
                    onRowClick={handleRowClick}
                  />
                ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No containers found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Server Modal for adding postgres server */}
      {isServerModalOpen && initialServerValues && (
        <ServerModal
          open={isServerModalOpen}
          onOpenChange={handleServerModalClose}
          mode="create"
          initialValues={initialServerValues}
        />
      )}
    </div>
  );
});
