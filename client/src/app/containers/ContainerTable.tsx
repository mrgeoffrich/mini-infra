import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { format } from "date-fns";
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
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Copy,
} from "lucide-react";

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

export function ContainerTable({
  containers,
  totalCount,
  isLoading,
  filterState,
}: ContainerTableProps) {
  const { page, limit, setPage, updateSort, sortBy, sortOrder } = filterState;

  // Copy text to clipboard
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  const columns: ColumnDef<ContainerInfo>[] = [
    {
      accessorKey: "name",
      header: () => (
        <Button
          variant="ghost"
          onClick={() => updateSort("name")}
          className="h-auto p-0 font-medium"
        >
          Container Name
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        const name = row.getValue("name") as string;
        return (
          <div className="flex items-center gap-2">
            <span className="font-medium">{name}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(name)}
              className="h-6 w-6 p-0"
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        );
      },
    },
    {
      accessorKey: "status",
      header: () => (
        <Button
          variant="ghost"
          onClick={() => updateSort("status")}
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
          onClick={() => updateSort("image")}
          className="h-auto p-0 font-medium"
        >
          Image
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        const image = row.getValue("image") as string;
        const imageTag = row.original.imageTag;
        const fullImage = `${image}:${imageTag}`;
        return (
          <div className="flex items-center gap-2">
            <div className="max-w-xs">
              <div className="font-mono text-sm truncate" title={fullImage}>
                {image}
              </div>
              <div className="text-xs text-muted-foreground">{imageTag}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(fullImage)}
              className="h-6 w-6 p-0 shrink-0"
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        );
      },
    },
    {
      accessorKey: "ports",
      header: "Ports",
      cell: ({ row }) => {
        const ports = row.getValue("ports") as ContainerInfo["ports"];
        if (!ports.length) {
          return <span className="text-muted-foreground">No ports</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {ports.slice(0, 2).map((port, index) => (
              <Badge key={index} variant="outline" className="text-xs">
                {port.public ? `${port.public}:${port.private}` : port.private}/
                {port.type}
              </Badge>
            ))}
            {ports.length > 2 && (
              <Badge variant="outline" className="text-xs">
                +{ports.length - 2} more
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "ipAddress",
      header: "IP Address",
      cell: ({ row }) => {
        const ip = row.getValue("ipAddress") as string;
        if (!ip) {
          return <span className="text-muted-foreground">-</span>;
        }
        return (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{ip}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(ip)}
              className="h-6 w-6 p-0"
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        );
      },
    },
    {
      accessorKey: "createdAt",
      header: () => (
        <Button
          variant="ghost"
          onClick={() => updateSort("createdAt")}
          className="h-auto p-0 font-medium"
        >
          Created
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        const createdAt = row.getValue("createdAt") as string;
        const date = new Date(createdAt);
        return (
          <div className="text-sm">
            <div>{format(date, "MMM d, yyyy")}</div>
            <div className="text-muted-foreground">
              {format(date, "HH:mm:ss")}
            </div>
          </div>
        );
      },
    },
  ];

  const table = useReactTable({
    data: containers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    state: {
      sorting: [{ id: sortBy, desc: sortOrder === "desc" }],
    },
  });

  const totalPages = Math.ceil(totalCount / limit);
  const startItem = (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, totalCount);

  if (isLoading) {
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
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="px-6 py-3">
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
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className="hover:bg-muted/50"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-6 py-4">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
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
            onClick={() => setPage(page - 1)}
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
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
