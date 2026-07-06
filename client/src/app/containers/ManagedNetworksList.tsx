import { useMemo, useState } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import type { ManagedNetworkView } from "@mini-infra/types";
import { useManagedNetworks, useNetworkGc } from "@/hooks/use-networks";
import { ManagedNetworkDetailSheet } from "@/components/networks/managed-network-detail-sheet";
import { NetworkDriftStatusBadge } from "@/components/networks/managed-network-shared";
import { SCOPE_LABEL, networkOwnerLabel } from "@/components/networks/managed-network-helpers";
import {
  IconArrowsSort,
  IconSearch,
  IconSparkles,
  IconLoader2,
} from "@tabler/icons-react";

/**
 * Network overhaul Phase 9 — the managed-network view of the Networks tab.
 * Surfaces `ManagedNetwork` rows (owner, purpose, status, member count) with
 * a click-through detail Sheet (`ManagedNetworkDetailSheet`) for the full
 * desired-vs-actual membership table, plus a host-wide GC sweep action.
 * Sibling of `NetworksList.tsx` (the raw Docker network list, unchanged) —
 * both live under the same "Networks" tab, see `NetworksTabContent.tsx`.
 */
export function ManagedNetworksList() {
  const [searchFilter, setSearchFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  // Selection is kept as an id, not a snapshot object, so the Sheet re-reads
  // the live query cache — a reconcile/enforce-toggle action while the Sheet
  // is open (or a socket-driven refetch) shows updated status without the
  // operator having to close and reopen it.
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const { data, isLoading, error } = useManagedNetworks();
  const gc = useNetworkGc();
  const selectedNetwork = useMemo(
    () => (data ?? []).find((n) => n.id === selectedNetworkId) ?? null,
    [data, selectedNetworkId],
  );

  const filteredNetworks = useMemo(() => {
    const networks = data ?? [];
    const term = searchFilter.toLowerCase();
    return networks.filter(
      (n) =>
        n.name.toLowerCase().includes(term) ||
        n.purpose.toLowerCase().includes(term) ||
        networkOwnerLabel(n).toLowerCase().includes(term),
    );
  }, [data, searchFilter]);

  const openDetail = (network: ManagedNetworkView) => {
    setSelectedNetworkId(network.id);
    setDetailOpen(true);
  };

  const columns = useMemo<ColumnDef<ManagedNetworkView>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            className="h-8 px-2"
          >
            Name
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="font-medium truncate max-w-[220px]" title={row.original.name}>
            {row.original.name}
          </div>
        ),
      },
      {
        id: "scope",
        header: "Scope",
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            {SCOPE_LABEL[row.original.scope]}
          </Badge>
        ),
      },
      {
        id: "owner",
        header: "Owner",
        cell: ({ row }) => (
          <span className="text-sm truncate max-w-[160px] inline-block" title={networkOwnerLabel(row.original)}>
            {networkOwnerLabel(row.original)}
          </span>
        ),
      },
      {
        accessorKey: "purpose",
        header: "Purpose",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{row.original.purpose}</span>
        ),
      },
      {
        id: "members",
        header: "Members",
        cell: ({ row }) => (
          <Badge variant={row.original.memberships.length > 0 ? "default" : "secondary"}>
            {row.original.memberships.length}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <NetworkDriftStatusBadge
            status={row.original.driftStatus}
            driftItemCount={row.original.driftItemCount}
          />
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" onClick={() => openDetail(row.original)}>
            View
          </Button>
        ),
      },
    ],
    [],
  );

  const table = useDataTable({
    data: filteredNetworks,
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  });

  if (error) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-destructive font-semibold mb-2">Failed to load managed networks</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search managed networks..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        {data && (
          <div className="text-sm text-muted-foreground">
            {filteredNetworks.length} of {data.length} networks
          </div>
        )}
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => gc.mutate(true)}
          disabled={gc.isPending}
          data-tour="network-gc-button"
        >
          {gc.isPending ? (
            <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <IconSparkles className="h-4 w-4 mr-2" />
          )}
          Run GC (dry run)
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <TableRow key={index}>
                  {columns.map((_, colIndex) => (
                    <TableCell key={colIndex}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => openDetail(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      onClick={cell.column.id === "actions" ? (e) => e.stopPropagation() : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No managed networks found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <ManagedNetworkDetailSheet
        network={selectedNetwork}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}
