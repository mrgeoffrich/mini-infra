import React from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  Cell,
} from "@tanstack/react-table";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ContainerInfo, ContainerFilters } from "@mini-infra/types";
import { ContainerStatusBadge } from "./ContainerStatusBadge";
import { ArrowUpDown, ChevronLeft, ChevronRight, Copy } from "lucide-react";

interface ContainerTableProps {
  containers: ContainerInfo[];
  totalCount: number;
  isLoading: boolean;
  filterState: {
    filters: ContainerFilters;
    sortBy: string;
    sortOrder: "asc" | "desc";
    page: number;
    limit: number;
    updateSort: (field: string, order?: "asc" | "desc") => void;
    setPage: (page: number) => void;
    setLimit: (limit: number) => void;
  };
}

const CopyButton = React.memo(
  ({
    text,
    className = "h-6 w-6 p-0",
  }: {
    text: string;
    className?: string;
  }) => {
    const handleCopy = React.useCallback(async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error("Failed to copy text: ", err);
      }
    }, [text]);

    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className={className}
      >
        <Copy className="h-3 w-3" />
      </Button>
    );
  },
  (prevProps, nextProps) =>
    prevProps.text === nextProps.text &&
    prevProps.className === nextProps.className,
);

CopyButton.displayName = "CopyButton";

const ContainerNameCell = React.memo(
  ({ name }: { name: string }) => (
    <div className="flex items-center gap-2 min-h-[2rem]">
      <span className="font-medium truncate flex-1">{name}</span>
      <CopyButton text={name} />
    </div>
  ),
  (prevProps, nextProps) => prevProps.name === nextProps.name,
);

ContainerNameCell.displayName = "ContainerNameCell";

const ContainerImageCell = React.memo(
  ({ image, imageTag }: { image: string; imageTag: string }) => {
    const fullImage = React.useMemo(
      () => `${image}:${imageTag}`,
      [image, imageTag],
    );
    return (
      <div className="flex items-center gap-2">
        <div className="max-w-xs">
          <div className="font-mono text-sm truncate" title={fullImage}>
            {image}
          </div>
          <div className="text-xs text-muted-foreground">{imageTag}</div>
        </div>
        <CopyButton text={fullImage} className="h-6 w-6 p-0 shrink-0" />
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.image === nextProps.image &&
    prevProps.imageTag === nextProps.imageTag,
);

ContainerImageCell.displayName = "ContainerImageCell";

const ContainerIPCell = React.memo(
  ({ ip }: { ip: string }) => {
    if (!ip) {
      return (
        <span className="text-muted-foreground min-h-[2rem] flex items-center">
          -
        </span>
      );
    }
    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        <span className="font-mono text-sm truncate flex-1">{ip}</span>
        <CopyButton text={ip} />
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.ip === nextProps.ip,
);

ContainerIPCell.displayName = "ContainerIPCell";

const ContainerPortsCell = React.memo(
  ({ ports }: { ports: ContainerInfo["ports"] }) => {
    if (!ports.length) {
      return (
        <span className="text-muted-foreground min-h-[2rem] flex items-center">
          No ports
        </span>
      );
    }
    return (
      <div className="flex flex-wrap gap-1 min-h-[2rem] items-center">
        {ports.slice(0, 2).map((port, index) => (
          <Badge
            key={index}
            variant="outline"
            className="text-xs whitespace-nowrap"
          >
            {port.public ? `${port.public}:${port.private}` : port.private}/
            {port.type}
          </Badge>
        ))}
        {ports.length > 2 && (
          <Badge variant="outline" className="text-xs whitespace-nowrap">
            +{ports.length - 2} more
          </Badge>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Deep comparison for ports array
    if (prevProps.ports.length !== nextProps.ports.length) return false;
    return prevProps.ports.every((port, index) => {
      const nextPort = nextProps.ports[index];
      return (
        port.public === nextPort.public &&
        port.private === nextPort.private &&
        port.type === nextPort.type
      );
    });
  },
);

ContainerPortsCell.displayName = "ContainerPortsCell";

const ContainerDateCell = React.memo(
  ({ createdAt }: { createdAt: string }) => {
    const { formatDate, formatTime } = useFormattedDate();
    const formattedDate = React.useMemo(
      () => formatDate(createdAt),
      [createdAt, formatDate],
    );
    const formattedTime = React.useMemo(() => formatTime(createdAt), [createdAt, formatTime]);

    return (
      <div className="text-sm">
        <div>{formattedDate}</div>
        <div className="text-muted-foreground">{formattedTime}</div>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.createdAt === nextProps.createdAt,
);

ContainerDateCell.displayName = "ContainerDateCell";

const ContainerRow = React.memo(
  ({
    container,
    visibleCells,
    getColumnWidth,
  }: {
    container: ContainerInfo;
    visibleCells: Cell<ContainerInfo, unknown>[];
    getColumnWidth: (index: number) => string;
  }) => (
    <TableRow key={container.id} className="hover:bg-muted/50 h-16">
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
  ),
  (prevProps, nextProps) => {
    // Only re-render if container data actually changed
    const prev = prevProps.container;
    const next = nextProps.container;

    return (
      prev.id === next.id &&
      prev.name === next.name &&
      prev.status === next.status &&
      prev.image === next.image &&
      prev.imageTag === next.imageTag &&
      prev.ipAddress === next.ipAddress &&
      prev.createdAt === next.createdAt &&
      JSON.stringify(prev.ports) === JSON.stringify(next.ports)
    );
  },
);

ContainerRow.displayName = "ContainerRow";

export const ContainerTable = React.memo(function ContainerTable({
  containers,
  totalCount,
  isLoading,
  filterState,
}: ContainerTableProps) {
  const { page, limit, setPage, updateSort, sortBy, sortOrder } = filterState;

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
  const handleCreatedSort = React.useCallback(
    () => updateSort("createdAt"),
    [updateSort],
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
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => <ContainerNameCell name={row.getValue("name")} />,
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
            <ArrowUpDown className="ml-2 h-4 w-4" />
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
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <ContainerImageCell
            image={row.getValue("image")}
            imageTag={row.original.imageTag}
          />
        ),
      },
      {
        accessorKey: "ports",
        header: "Ports",
        cell: ({ row }) => <ContainerPortsCell ports={row.getValue("ports")} />,
      },
      {
        accessorKey: "ipAddress",
        header: "IP Address",
        cell: ({ row }) => <ContainerIPCell ip={row.getValue("ipAddress")} />,
      },
      {
        accessorKey: "createdAt",
        header: () => (
          <Button
            variant="ghost"
            onClick={handleCreatedSort}
            className="h-auto p-0 font-medium"
          >
            Created
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <ContainerDateCell createdAt={row.getValue("createdAt")} />
        ),
      },
    ],
    [handleNameSort, handleStatusSort, handleImageSort, handleCreatedSort],
  );

  const sortingState = React.useMemo(
    () => [{ id: sortBy, desc: sortOrder === "desc" }],
    [sortBy, sortOrder],
  );

  const table = useReactTable({
    data: containers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    getRowId: (row) => row.id, // Use container ID as stable row key
    state: {
      sorting: sortingState,
    },
  });

  const totalPages = React.useMemo(
    () => Math.ceil(totalCount / limit),
    [totalCount, limit],
  );
  const startItem = React.useMemo(() => (page - 1) * limit + 1, [page, limit]);
  const endItem = React.useMemo(
    () => Math.min(page * limit, totalCount),
    [page, limit, totalCount],
  );

  // Fixed column widths to prevent layout shifts
  const getColumnWidth = React.useCallback((index: number) => {
    switch (index) {
      case 0:
        return "w-[200px] min-w-[200px] max-w-[200px]"; // Container Name
      case 1:
        return "w-[120px] min-w-[120px] max-w-[120px]"; // Status
      case 2:
        return "w-[280px] min-w-[280px] max-w-[280px]"; // Image
      case 3:
        return "w-[180px] min-w-[180px] max-w-[180px]"; // Ports
      case 4:
        return "w-[140px] min-w-[140px] max-w-[140px]"; // IP Address
      case 5:
        return "w-[160px] min-w-[160px] max-w-[160px]"; // Created
      default:
        return "";
    }
  }, []);

  const handlePrevPage = React.useCallback(
    () => setPage(page - 1),
    [setPage, page],
  );
  const handleNextPage = React.useCallback(
    () => setPage(page + 1),
    [setPage, page],
  );

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

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {startItem} to {endItem} of {totalCount} containers
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrevPage}
            disabled={page <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>

          <div className="flex items-center gap-1">
            {totalPages <= 7 ? (
              // Show all pages if there are 7 or fewer
              Array.from({ length: totalPages }, (_, i) => i + 1).map(
                (pageNum) => (
                  <Button
                    key={pageNum}
                    variant={page === pageNum ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPage(pageNum)}
                    className="w-8"
                  >
                    {pageNum}
                  </Button>
                ),
              )
            ) : (
              // Show abbreviated pagination for more than 7 pages
              <>
                {page > 3 && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(1)}
                      className="w-8"
                    >
                      1
                    </Button>
                    {page > 4 && (
                      <span className="text-muted-foreground">...</span>
                    )}
                  </>
                )}

                {Array.from(
                  { length: Math.min(5, totalPages) },
                  (_, i) => Math.max(1, Math.min(page - 2, totalPages - 4)) + i,
                )
                  .filter((pageNum) => pageNum <= totalPages)
                  .map((pageNum) => (
                    <Button
                      key={pageNum}
                      variant={page === pageNum ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPage(pageNum)}
                      className="w-8"
                    >
                      {pageNum}
                    </Button>
                  ))}

                {page < totalPages - 2 && (
                  <>
                    {page < totalPages - 3 && (
                      <span className="text-muted-foreground">...</span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(totalPages)}
                      className="w-8"
                    >
                      {totalPages}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            disabled={page >= totalPages}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
});
