import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
  getFilteredRowModel,
  ColumnFiltersState,
  RowSelectionState,
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
import { Checkbox } from "@/components/ui/checkbox";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VolumeFileInfo } from "@mini-infra/types";
import { useVolumeInspection, useInspectVolume, useFetchFileContents } from "@/hooks/use-volumes";
import {
  IconArrowLeft,
  IconArrowsSort,
  IconSearch,
  IconLoader2,
  IconRefresh,
  IconAlertCircle,
  IconFile,
  IconFolder,
  IconDownload,
  IconEye,
} from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";

// Helper function to format bytes to human-readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// Helper function to format permissions
function formatPermissions(permissions: string): string {
  // Convert octal to rwx format
  const perms = parseInt(permissions, 8);
  const owner = ((perms >> 6) & 7).toString();
  const group = ((perms >> 3) & 7).toString();
  const other = (perms & 7).toString();

  const toRWX = (n: string) => {
    const num = parseInt(n);
    return [
      num & 4 ? "r" : "-",
      num & 2 ? "w" : "-",
      num & 1 ? "x" : "-",
    ].join("");
  };

  return toRWX(owner) + toRWX(group) + toRWX(other);
}

export function VolumeInspectPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const volumeName = decodeURIComponent(name || "");

  const [searchFilter, setSearchFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "path", desc: false },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [showWarningDialog, setShowWarningDialog] = useState(false);

  const { data: inspection, isLoading, error } = useVolumeInspection({
    volumeName,
    enabled: !!volumeName,
  });

  const inspectVolume = useInspectVolume();
  const fetchFileContents = useFetchFileContents(volumeName, {
    onSuccess: () => {
      // Clear selection after successful fetch
      setRowSelection({});
    },
  });

  const handleReInspect = () => {
    inspectVolume.mutate(volumeName);
  };

  const handleFetchFileContents = () => {
    const selectedRows = table.getSelectedRowModel().rows;
    const selectedPaths = selectedRows.map((row) => row.original.path);

    // Show warning dialog if more than 20 files selected
    if (selectedPaths.length > 20) {
      setShowWarningDialog(true);
      return;
    }

    // Proceed with fetch
    fetchFileContents.mutate(selectedPaths);
  };

  const handleConfirmFetch = () => {
    const selectedRows = table.getSelectedRowModel().rows;
    const selectedPaths = selectedRows.map((row) => row.original.path);
    setShowWarningDialog(false);
    fetchFileContents.mutate(selectedPaths);
  };

  const handleViewFile = (filePath: string) => {
    navigate(`/containers/volumes/${encodeURIComponent(volumeName)}/files/${encodeURIComponent(filePath)}`);
  };

  const filteredFiles = useMemo(() => {
    if (!inspection?.files) return [];

    return inspection.files.filter((file) =>
      file.path.toLowerCase().includes(searchFilter.toLowerCase())
    );
  }, [inspection?.files, searchFilter]);

  const columns: ColumnDef<VolumeFileInfo>[] = [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      accessorKey: "path",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            className="h-8 px-2"
          >
            Path
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        );
      },
      cell: ({ row }) => {
        const path = row.original.path;
        const isRoot = path === "/";

        return (
          <div className="flex items-center gap-2">
            {isRoot ? (
              <IconFolder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <IconFile className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
            <span className="font-mono text-xs max-w-md truncate" title={path}>
              {path}
            </span>
          </div>
        );
      },
    },
    {
      accessorKey: "size",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            className="h-8 px-2"
          >
            Size
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        );
      },
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatBytes(row.original.size)}
        </span>
      ),
    },
    {
      accessorKey: "permissions",
      header: "Permissions",
      cell: ({ row }) => (
        <code className="text-xs bg-muted px-2 py-1 rounded">
          {formatPermissions(row.original.permissions)}
        </code>
      ),
    },
    {
      accessorKey: "owner",
      header: "Owner",
      cell: ({ row }) => (
        <span className="text-sm font-mono">{row.original.owner}</span>
      ),
    },
    {
      accessorKey: "modifiedAt",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            className="h-8 px-2"
          >
            Modified
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        );
      },
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatDistanceToNow(new Date(row.original.modifiedAt), {
            addSuffix: true,
          })}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const filePath = row.original.path;
        return (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleViewFile(filePath)}
            title="View file contents"
          >
            <IconEye className="h-4 w-4" />
          </Button>
        );
      },
      enableSorting: false,
    },
  ];

  const table = useReactTable({
    data: filteredFiles,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    getRowId: (row) => row.path, // Use file path as unique row ID
    state: {
      sorting,
      columnFilters,
      rowSelection,
    },
  });

  const selectedRowCount = table.getSelectedRowModel().rows.length;

  if (!volumeName) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <IconAlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <p className="text-destructive font-semibold mb-2">
            Volume name is required
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center p-8">
        <div className="text-center max-w-lg">
          <IconAlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <p className="text-destructive font-semibold mb-2">
            Failed to load inspection
          </p>
          <p className="text-sm text-muted-foreground mb-4">{error.message}</p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={() => navigate("/containers")}>
              <IconArrowLeft className="mr-2 h-4 w-4" />
              Back to Volumes
            </Button>
            <Button onClick={handleReInspect} disabled={inspectVolume.isPending}>
              {inspectVolume.isPending ? (
                <>
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <IconRefresh className="mr-2 h-4 w-4" />
                  Start Inspection
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const isRunning = inspection?.status === "running" || inspection?.status === "pending";
  const isFailed = inspection?.status === "failed";
  const isCompleted = inspection?.status === "completed";

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/containers")}
            className="mb-2"
          >
            <IconArrowLeft className="mr-2 h-4 w-4" />
            Back to Volumes
          </Button>
          <h1 className="text-3xl font-bold tracking-tight">Volume Inspection</h1>
          <p className="text-muted-foreground">
            <code className="text-sm bg-muted px-2 py-1 rounded">{volumeName}</code>
          </p>
        </div>
        <Button
          onClick={handleReInspect}
          disabled={inspectVolume.isPending || isRunning}
        >
          {inspectVolume.isPending || isRunning ? (
            <>
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              {isRunning ? "Inspecting..." : "Starting..."}
            </>
          ) : (
            <>
              <IconRefresh className="mr-2 h-4 w-4" />
              Re-inspect
            </>
          )}
        </Button>
      </div>

      {/* Status Badge */}
      {inspection && (
        <div className="flex items-center gap-2">
          <Badge
            variant={
              isCompleted ? "default" : isFailed ? "destructive" : "secondary"
            }
          >
            {inspection.status.toUpperCase()}
          </Badge>
          {inspection.inspectedAt && (
            <span className="text-sm text-muted-foreground">
              Inspected{" "}
              {formatDistanceToNow(new Date(inspection.inspectedAt), {
                addSuffix: true,
              })}
            </span>
          )}
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-full" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-40 w-full" />
          </CardContent>
        </Card>
      )}

      {/* Running State */}
      {isRunning && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <IconLoader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <CardTitle>Inspection in Progress</CardTitle>
            </div>
            <CardDescription>
              Scanning files in volume '{volumeName}'... This may take a few moments.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Failed State */}
      {isFailed && (
        <Card className="border-destructive">
          <CardHeader>
            <div className="flex items-center gap-2">
              <IconAlertCircle className="h-6 w-6 text-destructive" />
              <CardTitle className="text-destructive">Inspection Failed</CardTitle>
            </div>
            <CardDescription>{inspection.errorMessage}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Results - Only show when completed */}
      {isCompleted && inspection.files && (
        <>
          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Files</CardTitle>
                <IconFile className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {inspection.fileCount?.toLocaleString() || 0}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Size</CardTitle>
                <IconFolder className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {inspection.totalSize ? formatBytes(inspection.totalSize) : "0 B"}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Scan Duration</CardTitle>
                <IconLoader2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {inspection.durationMs
                    ? `${(inspection.durationMs / 1000).toFixed(2)}s`
                    : "—"}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Files Table */}
          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
              <CardDescription>
                All files found in the volume during inspection
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Search Filter and Fetch Button */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <div className="relative flex-1 max-w-sm">
                  <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search files..."
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Button
                  onClick={handleFetchFileContents}
                  disabled={selectedRowCount === 0 || fetchFileContents.isPending}
                  variant="default"
                >
                  {fetchFileContents.isPending ? (
                    <>
                      <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                      Fetching...
                    </>
                  ) : (
                    <>
                      <IconDownload className="mr-2 h-4 w-4" />
                      Fetch File Contents ({selectedRowCount})
                    </>
                  )}
                </Button>
                <div className="text-sm text-muted-foreground ml-auto">
                  {filteredFiles.length} of {inspection.files.length} files
                </div>
              </div>

              {/* Files Table */}
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
                    {table.getRowModel().rows?.length ? (
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
                          No files found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Warning Dialog for Large Selections */}
      <AlertDialog open={showWarningDialog} onOpenChange={setShowWarningDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Large Selection Warning</AlertDialogTitle>
            <AlertDialogDescription>
              You have selected {selectedRowCount} files. Fetching a large number of files may take some time and consume system resources. Are you sure you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmFetch}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
