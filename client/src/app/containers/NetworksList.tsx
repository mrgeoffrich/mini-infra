import { useState, useMemo } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
} from "@tanstack/react-table";
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
import { DockerNetwork } from "@mini-infra/types";
import { useNetworks, useDeleteNetwork } from "@/hooks/use-networks";
import { IconTrash, IconArrowsSort, IconSearch } from "@tabler/icons-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function NetworksList() {
  const [searchFilter, setSearchFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);
  const [networkToDelete, setNetworkToDelete] = useState<DockerNetwork | null>(
    null
  );

  const { data, isLoading, error } = useNetworks();
  const deleteNetwork = useDeleteNetwork({
    onSuccess: () => {
      setNetworkToDelete(null);
    },
  });

  const filteredNetworks = useMemo(() => {
    if (!data?.networks) return [];

    return data.networks.filter((network) =>
      network.name.toLowerCase().includes(searchFilter.toLowerCase())
    );
  }, [data?.networks, searchFilter]);

  const columns: ColumnDef<DockerNetwork>[] = [
    {
      accessorKey: "name",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            className="h-8 px-2"
          >
            Name
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        );
      },
      cell: ({ row }) => (
        <div className="font-medium">{row.original.name}</div>
      ),
    },
    {
      accessorKey: "driver",
      header: "Driver",
      cell: ({ row }) => (
        <Badge variant="outline" className="text-xs">
          {row.original.driver}
        </Badge>
      ),
    },
    {
      accessorKey: "scope",
      header: "Scope",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.scope}
        </span>
      ),
    },
    {
      accessorKey: "containers",
      header: "Containers",
      cell: ({ row }) => {
        const count = row.original.containers.length;
        return (
          <div className="flex items-center gap-2">
            <Badge variant={count > 0 ? "default" : "secondary"}>
              {count}
            </Badge>
            {count > 0 && (
              <span className="text-xs text-muted-foreground">
                {row.original.containers.map((c) => c.name).join(", ")}
              </span>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "subnet",
      header: "Subnet",
      cell: ({ row }) => {
        const subnets = row.original.ipam.config
          .map((cfg) => cfg.subnet)
          .filter(Boolean);
        return (
          <div className="font-mono text-xs">
            {subnets.length > 0 ? subnets.join(", ") : "—"}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const network = row.original;
        const hasContainers = network.containers.length > 0;
        const isSystemNetwork = ["bridge", "host", "none"].includes(
          network.name
        );

        return (
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setNetworkToDelete(network)}
              disabled={hasContainers || isSystemNetwork}
              title={
                isSystemNetwork
                  ? "Cannot delete system network"
                  : hasContainers
                  ? "Cannot delete network with attached containers"
                  : "Delete network"
              }
            >
              <IconTrash className="h-4 w-4" />
            </Button>
          </div>
        );
      },
    },
  ];

  const table = useReactTable({
    data: filteredNetworks,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  if (error) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-destructive font-semibold mb-2">
            Failed to load networks
          </p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Search Filter */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search networks..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        {data && (
          <div className="text-sm text-muted-foreground">
            {filteredNetworks.length} of {data.totalCount} networks
          </div>
        )}
      </div>

      {/* Networks Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              // Loading skeleton
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
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
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
                  No networks found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!networkToDelete}
        onOpenChange={(open) => !open && setNetworkToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Network</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the network "
              {networkToDelete?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (networkToDelete) {
                  deleteNetwork.mutate(networkToDelete.id);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
