import React from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  Cell,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AzureContainerInfo } from "@mini-infra/types";
import { getColumnWidth } from "./constants";

interface AzureContainerTableProps {
  containers: AzureContainerInfo[];
  columns: ColumnDef<AzureContainerInfo>[];
  sortBy: string;
  sortOrder: "asc" | "desc";
}

// Container row component
const ContainerRow = React.memo(
  ({
    container,
    visibleCells,
  }: {
    container: AzureContainerInfo;
    visibleCells: Cell<AzureContainerInfo, unknown>[];
  }) => (
    <TableRow key={container.name} className="hover:bg-muted/50 h-16">
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
    const prev = prevProps.container;
    const next = nextProps.container;

    return (
      prev.name === next.name &&
      prev.lastModified === next.lastModified &&
      prev.leaseStatus === next.leaseStatus &&
      prev.publicAccess === next.publicAccess &&
      JSON.stringify(prev.metadata) === JSON.stringify(next.metadata)
    );
  },
);

ContainerRow.displayName = "ContainerRow";

export const AzureContainerTable = React.memo(
  ({ containers, columns, sortBy, sortOrder }: AzureContainerTableProps) => {
    // React Table setup
    const sortingState = React.useMemo(
      () => [{ id: sortBy, desc: sortOrder === "desc" }],
      [sortBy, sortOrder],
    );

    const table = useReactTable({
      data: containers,
      columns,
      getCoreRowModel: getCoreRowModel(),
      manualSorting: true,
      getRowId: (row) => row.name,
      state: {
        sorting: sortingState,
      },
    });

    return (
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
                    key={row.original.name}
                    container={row.original}
                    visibleCells={row.getVisibleCells()}
                  />
                ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No containers found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    );
  },
);

AzureContainerTable.displayName = "AzureContainerTable";
