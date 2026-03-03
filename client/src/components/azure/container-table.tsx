import React from "react";
import { flexRender, Cell, HeaderGroup, Row } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AzureContainerInfo } from "@mini-infra/types";

export const getColumnWidth = (index: number) => {
  switch (index) {
    case 0:
      return "w-[250px] min-w-[250px] max-w-[250px]"; // Container Name
    case 1:
      return "w-[200px] min-w-[200px] max-w-[200px]"; // Last Modified
    case 2:
      return "w-[140px] min-w-[140px] max-w-[140px]"; // Lease Status
    case 3:
      return "w-[120px] min-w-[120px] max-w-[120px]"; // Access Level
    case 4:
      return "w-[140px] min-w-[140px] max-w-[140px]"; // Metadata
    case 5:
      return "w-[180px] min-w-[180px] max-w-[180px]"; // Actions
    default:
      return "";
  }
};

export const ContainerRow = React.memo(
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

interface ContainerTableProps {
  headerGroups: HeaderGroup<AzureContainerInfo>[];
  rows: Row<AzureContainerInfo>[];
  columnCount: number;
}

export const ContainerTable = React.memo(function ContainerTable({
  headerGroups,
  rows,
  columnCount,
}: ContainerTableProps) {
  return (
    <div className="rounded-md border">
      <Table className="table-fixed">
        <TableHeader>
          {headerGroups.map((headerGroup) => (
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
          {rows.length ? (
            rows.map((row) => (
              <ContainerRow
                key={row.original.name}
                container={row.original}
                visibleCells={row.getVisibleCells()}
              />
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={columnCount}
                className="h-24 text-center"
              >
                No containers found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
});
