import { useState, useMemo } from "react";
import { useNavigate } from "react-router";
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
import { DockerVolume } from "@mini-infra/types";
import { useVolumes, useDeleteVolume, useInspectVolume, useVolumeInspection } from "@/hooks/use-volumes";
import { IconTrash, IconArrowsSort, IconSearch, IconEye, IconScan, IconLoader2 } from "@tabler/icons-react";
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

// Helper function to format bytes to human-readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// Volume Actions Component
function VolumeActions({ volume }: { volume: DockerVolume }) {
  const navigate = useNavigate();
  const [volumeToDelete, setVolumeToDelete] = useState(false);

  const deleteVolume = useDeleteVolume({
    onSuccess: () => {
      setVolumeToDelete(false);
    },
  });
  const inspectVolume = useInspectVolume();

  // Check if inspection exists and its status
  const { data: inspection } = useVolumeInspection({
    volumeName: volume.name,
    enabled: true,
  });

  const isInspecting = inspection?.status === "running" || inspection?.status === "pending";
  const canViewResults = inspection?.status === "completed";

  const handleInspect = () => {
    inspectVolume.mutate(volume.name);
  };

  const handleViewResults = () => {
    navigate(`/containers/volumes/${encodeURIComponent(volume.name)}/inspect`);
  };

  const handleDelete = () => {
    deleteVolume.mutate(volume.name);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {canViewResults && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleViewResults}
            title="View inspection results"
          >
            <IconEye className="h-4 w-4" />
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={handleInspect}
          disabled={isInspecting || inspectVolume.isPending}
          title={isInspecting ? "Inspection in progress..." : "Inspect volume"}
        >
          {isInspecting || inspectVolume.isPending ? (
            <IconLoader2 className="h-4 w-4 animate-spin" />
          ) : (
            <IconScan className="h-4 w-4" />
          )}
        </Button>

        <Button
          variant="destructive"
          size="sm"
          onClick={() => setVolumeToDelete(true)}
          disabled={volume.inUse}
          title={
            volume.inUse
              ? "Cannot delete volume in use by containers"
              : "Delete volume"
          }
        >
          <IconTrash className="h-4 w-4" />
        </Button>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={volumeToDelete} onOpenChange={setVolumeToDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Volume?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete volume{" "}
              <span className="font-semibold">{volume.name}</span>? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function VolumesList() {
  const [searchFilter, setSearchFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);

  const { data, isLoading, error } = useVolumes();

  const filteredVolumes = useMemo(() => {
    const volumes = data?.volumes ?? [];
    return volumes.filter((volume) =>
      volume.name.toLowerCase().includes(searchFilter.toLowerCase()),
    );
  }, [data, searchFilter]);

  const columns = useMemo<ColumnDef<DockerVolume>[]>(() => [
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
        <div className="font-medium max-w-md truncate" title={row.original.name}>
          {row.original.name}
        </div>
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
      accessorKey: "mountpoint",
      header: "Mount Point",
      cell: ({ row }) => (
        <div className="font-mono text-xs max-w-sm truncate" title={row.original.mountpoint}>
          {row.original.mountpoint}
        </div>
      ),
    },
    {
      accessorKey: "size",
      header: "Size",
      cell: ({ row }) => {
        const size = row.original.usageData?.size;
        return (
          <span className="text-sm text-muted-foreground">
            {size ? formatBytes(size) : "—"}
          </span>
        );
      },
    },
    {
      accessorKey: "containerCount",
      header: "In Use",
      cell: ({ row }) => {
        const count = row.original.containerCount;
        const inUse = row.original.inUse;
        return (
          <Badge variant={inUse ? "default" : "secondary"}>
            {count > 0 ? `${count} container${count > 1 ? "s" : ""}` : "Not in use"}
          </Badge>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const volume = row.original;
        return <VolumeActions volume={volume} />;
      },
    },
  ], []);

  const table = useDataTable({
    data: filteredVolumes,
    columns,
    getRowId: (row) => row.name,
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
            Failed to load volumes
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
            placeholder="Search volumes..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        {data && (
          <div className="text-sm text-muted-foreground">
            {filteredVolumes.length} of {data.totalCount} volumes
          </div>
        )}
      </div>

      {/* Volumes Table */}
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
                  No volumes found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
