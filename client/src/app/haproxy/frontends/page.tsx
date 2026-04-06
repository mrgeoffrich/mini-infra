import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconNetwork,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconEye,
  IconEdit,
  IconTrash,
  IconDots,
  IconShield,
  IconAlertCircle,
} from "@tabler/icons-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
  ColumnDef,
} from "@tanstack/react-table";

import { useAllFrontends } from "@/hooks/use-haproxy-frontend";
import { useDeleteManualFrontend } from "@/hooks/use-manual-haproxy-frontend";
import { useEnvironments } from "@/hooks/use-environments";
import { FrontendStatusBadge } from "@/components/haproxy/frontend-status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteFrontendDialog } from "@/components/haproxy/delete-frontend-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { HAProxyFrontendInfo } from "@mini-infra/types";

export function FrontendsListPage() {
  const navigate = useNavigate();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [environmentFilter, setEnvironmentFilter] = useState<string>("all");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [frontendToDelete, setFrontendToDelete] = useState<HAProxyFrontendInfo | null>(null);

  // Fetch data
  const { data: frontendsResponse, isLoading, error, refetch } = useAllFrontends({});

  const { data: environmentsResponse } = useEnvironments({
    filters: { limit: 100 },
  });

  const { mutate: deleteFrontend, isPending: isDeleting } = useDeleteManualFrontend();

  const frontends = frontendsResponse?.data || [];
  const environments = environmentsResponse?.environments || [];

  // Create environment lookup map
  const environmentsById = useMemo(() => {
    const map = new Map();
    environments.forEach(env => {
      map.set(env.id, env);
    });
    return map;
  }, [environments]);

  // Filter frontends
  const filteredFrontends = useMemo(() => {
    return frontends.filter(frontend => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const routeHostnamesMatch = frontend.routeHostnames?.some(
          (hostname) => hostname.toLowerCase().includes(query)
        );
        const matchesSearch =
          frontend.frontendName.toLowerCase().includes(query) ||
          routeHostnamesMatch ||
          (frontend.containerName && frontend.containerName.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      // Type filter
      if (typeFilter !== "all") {
        if (typeFilter === "shared") {
          // Filter for shared frontends
          if (!frontend.isSharedFrontend) return false;
        } else {
          // Filter for other types (deployment, manual)
          if (frontend.frontendType !== typeFilter) return false;
        }
      }

      // Status filter
      if (statusFilter !== "all" && frontend.status !== statusFilter) {
        return false;
      }

      // Environment filter
      if (environmentFilter !== "all" && frontend.environmentId !== environmentFilter) {
        return false;
      }

      return true;
    });
  }, [frontends, searchQuery, typeFilter, statusFilter, environmentFilter]);

  // Define columns
  const columns = useMemo<ColumnDef<HAProxyFrontendInfo>[]>(
    () => [
      {
        accessorKey: "frontendName",
        header: "Frontend Name",
        cell: ({ row }) => (
          <div className="font-medium">{row.original.frontendName}</div>
        ),
      },
      {
        accessorKey: "routes",
        header: "Routes",
        cell: ({ row }) => {
          const frontend = row.original;

          // Manual frontends don't have routes directly — they route
          // through a shared frontend. Show the hostname with an indicator.
          if (frontend.frontendType === "manual" && frontend.hostname) {
            return (
              <div className="text-sm">
                <span>{frontend.hostname}</span>
                <div className="text-xs text-muted-foreground mt-0.5">
                  via {frontend.sharedFrontendName ? (
                    <span
                      className="underline cursor-pointer hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/haproxy/frontends/${frontend.sharedFrontendName}`);
                      }}
                    >
                      {frontend.sharedFrontendName}
                    </span>
                  ) : "shared frontend"}
                </div>
              </div>
            );
          }

          const hostnames = frontend.routeHostnames || [];
          if (hostnames.length === 0) {
            return (
              <div className="text-sm text-muted-foreground">No routes</div>
            );
          }
          const displayHostnames = hostnames.slice(0, 3);
          const remaining = hostnames.length - 3;
          return (
            <div className="text-sm">
              {displayHostnames.map((hostname, index) => (
                <span key={hostname}>
                  {hostname}
                  {index < displayHostnames.length - 1 && ", "}
                </span>
              ))}
              {remaining > 0 && (
                <span className="text-muted-foreground"> +{remaining} more</span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "environmentId",
        header: "Environment",
        cell: ({ row }) => {
          const environment = environmentsById.get(row.original.environmentId || "");
          return (
            <div className="text-sm">
              {environment ? environment.name : "Unknown"}
            </div>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <FrontendStatusBadge status={row.original.status} />
        ),
      },
      {
        accessorKey: "useSSL",
        header: "SSL",
        cell: ({ row }) => (
          row.original.useSSL ? (
            <IconShield className="h-4 w-4 text-green-600" />
          ) : (
            <div className="text-muted-foreground text-xs">No</div>
          )
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const frontend = row.original;
          const isManual = frontend.frontendType === "manual";

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="sm">
                  <IconDots className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); navigate(`/haproxy/frontends/${frontend.frontendName}`); }}
                >
                  <IconEye className="h-4 w-4 mr-2" />
                  View Details
                </DropdownMenuItem>
                {isManual && (
                  <>
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); navigate(`/haproxy/frontends/${frontend.frontendName}/edit`); }}
                    >
                      <IconEdit className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); handleDeleteClick(frontend); }}
                      className="text-destructive focus:text-destructive"
                    >
                      <IconTrash className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [navigate, environmentsById]
  );

  const table = useReactTable({
    data: filteredFrontends,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  const handleDeleteClick = (frontend: HAProxyFrontendInfo) => {
    setFrontendToDelete(frontend);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (frontendToDelete) {
      deleteFrontend(frontendToDelete.frontendName, {
        onSuccess: () => {
          setDeleteDialogOpen(false);
          setFrontendToDelete(null);
        },
      });
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setFrontendToDelete(null);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-96" />
            </div>
          </div>
        </div>
        <div className="px-4 lg:px-6">
          <Skeleton className="h-[500px] w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconNetwork className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Load Balancer</h1>
              <p className="text-muted-foreground">
                Manage frontend connections and routing configuration
              </p>
            </div>
          </div>

          <div className="mt-6 p-4 border border-destructive/50 bg-destructive/10 rounded-md flex items-start gap-3">
            <IconAlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">Failed to load frontends</p>
              <p className="text-sm text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconNetwork className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Load Balancer</h1>
              <p className="text-muted-foreground">
                Manage frontend connections and routing configuration
              </p>
            </div>
          </div>

          <Button onClick={() => navigate("/haproxy/frontends/new/manual")}>
            <IconPlus className="h-4 w-4 mr-2" />
            Connect Container
          </Button>
        </div>
      </div>

      {/* Filters Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Filter Frontends</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Type Filter */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Type</label>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="deployment">Deployment</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="shared">Shared</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Environment Filter */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Environment</label>
                <Select value={environmentFilter} onValueChange={setEnvironmentFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Environments</SelectItem>
                    {environments.map(env => (
                      <SelectItem key={env.id} value={env.id}>
                        {env.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Status Filter */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Status</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Search */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Search</label>
                <div className="relative">
                  <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search frontends..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Frontends Table */}
      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Frontends ({filteredFrontends.length})</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
              >
                <IconRefresh className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {filteredFrontends.length === 0 ? (
              <div className="text-center py-12">
                <IconNetwork className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-semibold">No frontends found</h3>
                <p className="mt-2 text-muted-foreground">
                  {frontends.length === 0
                    ? "Get started by connecting a container to HAProxy."
                    : "Try adjusting your filters to see more results."}
                </p>
                {frontends.length === 0 && (
                  <Button
                    onClick={() => navigate("/haproxy/frontends/new/manual")}
                    className="mt-4"
                  >
                    <IconPlus className="h-4 w-4 mr-2" />
                    Connect Container
                  </Button>
                )}
              </div>
            ) : (
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
                    {table.getRowModel().rows.map((row) => (
                      <TableRow
                        key={row.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => navigate(`/haproxy/frontends/${row.original.frontendName}`)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext()
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteFrontendDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        frontend={frontendToDelete}
        isDeleting={isDeleting}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}

export default FrontendsListPage;
