import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  IconTable,
  IconArrowUp,
  IconArrowDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useTableData } from "@/hooks/use-table-data";
import type { TableDataRequest } from "@mini-infra/types";

interface TableDataGridProps {
  serverId: string;
  databaseId: string;
  tableName: string | null;
}

export function TableDataGrid({ serverId, databaseId, tableName }: TableDataGridProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [sorting, setSorting] = useState<SortingState>([]);

  // Build request params
  const params: TableDataRequest = useMemo(() => ({
    page,
    pageSize,
    sortColumn: sorting[0]?.id,
    sortDirection: sorting[0]?.desc ? "desc" : "asc",
  }), [page, pageSize, sorting]);

  // Fetch table data
  const { data: response, isLoading, error } = useTableData(
    serverId,
    databaseId,
    tableName || undefined,
    params
  );

  const tableData = response?.data;

  // Create columns dynamically from table metadata
  const columns = useMemo<ColumnDef<Record<string, any>>[]>(() => {
    if (!tableData?.columns) return [];

    return tableData.columns.map((col) => ({
      id: col.name,
      accessorKey: col.name,
      header: ({ column }) => {
        const isSorted = column.getIsSorted();
        return (
          <div
            className="flex items-center gap-2 cursor-pointer select-none hover:text-primary"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <span className="font-medium">{col.name}</span>
            {col.isPrimaryKey && <Badge variant="outline" className="text-xs">PK</Badge>}
            {isSorted && (
              isSorted === "asc" ? (
                <IconArrowUp className="h-3 w-3" />
              ) : (
                <IconArrowDown className="h-3 w-3" />
              )
            )}
          </div>
        );
      },
      cell: ({ getValue }) => {
        const value = getValue();
        const displayValue = value === null ? <span className="text-muted-foreground italic">NULL</span> : String(value);

        return (
          <div
            className="font-mono text-sm cursor-pointer hover:bg-accent px-2 py-1 rounded"
            onClick={() => {
              if (value !== null) {
                navigator.clipboard.writeText(String(value));
                toast.success("Copied to clipboard");
              }
            }}
          >
            {displayValue}
          </div>
        );
      },
      meta: {
        dataType: col.dataType,
        isNullable: col.isNullable,
      },
    }));
  }, [tableData?.columns]);

  const table = useReactTable({
    data: tableData?.rows || [],
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualSorting: true,
    manualPagination: true,
    pageCount: tableData?.totalPages || 0,
  });

  // Handle page size change
  const handlePageSizeChange = (value: string) => {
    setPageSize(Number(value));
    setPage(1); // Reset to first page
  };

  // Copy cell value
  const copyToClipboard = (value: any) => {
    if (value !== null && value !== undefined) {
      navigator.clipboard.writeText(String(value));
      toast.success("Copied to clipboard");
    }
  };

  if (!tableName) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <IconTable className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground">Select a table to view its data</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b">
          <Skeleton className="h-10 w-full mb-2" />
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1 overflow-auto p-4">
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-destructive mb-2">Error loading table data</p>
          <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
        </div>
      </div>
    );
  }

  if (!tableData) {
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-lg font-semibold">{tableName}</h3>
            <p className="text-sm text-muted-foreground">
              {tableData.totalRows.toLocaleString()} rows total
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
                <SelectItem value="250">250 rows</SelectItem>
                <SelectItem value="500">500 rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Column Info */}
        <div className="text-sm text-muted-foreground">
          {tableData.columns.length} columns
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="whitespace-nowrap">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-center py-8">
                  <p className="text-muted-foreground">No data in this table</p>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="max-w-md truncate">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="p-4 border-t">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {page} of {tableData.totalPages} ({tableData.totalRows.toLocaleString()} total rows)
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <IconChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(tableData.totalPages, p + 1))}
              disabled={page === tableData.totalPages}
            >
              Next
              <IconChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
