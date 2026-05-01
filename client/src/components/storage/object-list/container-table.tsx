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
import { getColumnWidth } from "./container-table-utils";
import type { StorageLocationRow } from "./types";

interface LocationRowComponentProps<TRow extends StorageLocationRow> {
  location: TRow;
  visibleCells: Cell<TRow, unknown>[];
}

function LocationRowInner<TRow extends StorageLocationRow>({
  location,
  visibleCells,
}: LocationRowComponentProps<TRow>) {
  return (
    <TableRow key={location.name} className="hover:bg-muted/50 h-16">
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
}

// React.memo doesn't preserve generics, so we keep the inner generic component
// and memoize a runtime-erased wrapper. Equality stays shallow over the row's
// stable identity fields, matching the original behaviour.
export const LocationRow = React.memo(
  LocationRowInner as <TRow extends StorageLocationRow>(
    props: LocationRowComponentProps<TRow>,
  ) => React.ReactElement,
  (prevProps, nextProps) => {
    const prev = prevProps.location;
    const next = nextProps.location;

    return (
      prev.name === next.name &&
      prev.lastModified === next.lastModified &&
      JSON.stringify(prev.metadata) === JSON.stringify(next.metadata)
    );
  },
) as <TRow extends StorageLocationRow>(
  props: LocationRowComponentProps<TRow>,
) => React.ReactElement;

interface LocationTableProps<TRow extends StorageLocationRow> {
  headerGroups: HeaderGroup<TRow>[];
  rows: Row<TRow>[];
  columnCount: number;
}

function LocationTableInner<TRow extends StorageLocationRow>({
  headerGroups,
  rows,
  columnCount,
}: LocationTableProps<TRow>) {
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
              <LocationRow
                key={row.original.name}
                location={row.original}
                visibleCells={row.getVisibleCells()}
              />
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={columnCount}
                className="h-24 text-center"
              >
                No locations found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export const LocationTable = React.memo(
  LocationTableInner as <TRow extends StorageLocationRow>(
    props: LocationTableProps<TRow>,
  ) => React.ReactElement,
) as <TRow extends StorageLocationRow>(
  props: LocationTableProps<TRow>,
) => React.ReactElement;
