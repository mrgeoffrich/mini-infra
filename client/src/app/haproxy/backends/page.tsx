import { useState, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  IconServer,
  IconRefresh,
  IconSearch,
  IconEye,
  IconDots,
  IconAlertCircle,
  IconRocket,
  IconSettings,
  IconPlus,
} from "@tabler/icons-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
  ColumnDef,
} from "@tanstack/react-table";

import { useAllBackends } from "@/hooks/use-haproxy-backends";
import { useEnvironments } from "@/hooks/use-environments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { HAProxyBackendInfo } from "@mini-infra/types";

function BackendStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge
          variant="outline"
          className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950"
        >
          Active
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="outline"
          className="text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950"
        >
          Failed
        </Badge>
      );
    case "removed":
      return (
        <Badge
          variant="outline"
          className="text-gray-700 border-gray-200 bg-gray-50 dark:text-gray-300 dark:border-gray-800 dark:bg-gray-950"
        >
          Removed
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function BackendSourceBadge({ sourceType }: { sourceType: string }) {
  switch (sourceType) {
    case "deployment":
      return (
        <Badge variant="secondary" className="gap-1">
          <IconRocket className="h-3 w-3" />
          Deployment
        </Badge>
      );
    case "manual":
      return (
        <Badge variant="outline" className="gap-1">
          <IconSettings className="h-3 w-3" />
          Manual
        </Badge>
      );
    default:
      return <Badge variant="outline">{sourceType}</Badge>;
  }
}

function BalanceBadge({ algorithm }: { algorithm: string }) {
  return (
    <Badge variant="secondary" className="font-mono text-xs">
      {algorithm}
    </Badge>
  );
}

export function BackendsListPage() {
  const navigate = useNavigate();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [environmentFilter, setEnvironmentFilter] = useState<string>("all");

  // Fetch data
  const {
    data: backendsResponse,
    isLoading,
    error,
    refetch,
  } = useAllBackends({});

  const { data: environmentsResponse } = useEnvironments({
    filters: { limit: 100 },
  });

  const backends = backendsResponse?.data || [];
  const environments = environmentsResponse?.environments || [];

  // Create environment lookup map
  const environmentsById = useMemo(() => {
    const map = new Map();
    environments.forEach((env) => {
      map.set(env.id, env);
    });
    return map;
  }, [environments]);

  // Filter backends
  const filteredBackends = useMemo(() => {
    return backends.filter((backend) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesSearch = backend.name.toLowerCase().includes(query);
        if (!matchesSearch) return false;
      }

      // Status filter
      if (statusFilter !== "all" && backend.status !== statusFilter) {
        return false;
      }

      // Source type filter
      if (sourceFilter !== "all" && backend.sourceType !== sourceFilter) {
        return false;
      }

      // Environment filter
      if (
        environmentFilter !== "all" &&
        backend.environmentId !== environmentFilter
      ) {
        return false;
      }

      return true;
    });
  }, [backends, searchQuery, statusFilter, sourceFilter, environmentFilter]);

  // Define columns
  const columns = useMemo<ColumnDef<HAProxyBackendInfo>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="font-medium font-mono">{row.original.name}</div>
        ),
      },
      {
        accessorKey: "environmentId",
        header: "Environment",
        cell: ({ row }) => {
          const environment = environmentsById.get(
            row.original.environmentId || "",
          );
          return (
            <div className="text-sm">
              {environment ? environment.name : "Unknown"}
            </div>
          );
        },
      },
      {
        accessorKey: "serversCount",
        header: "Servers",
        cell: ({ row }) => {
          const count = row.original.serversCount || 0;
          return (
            <Badge
              variant="outline"
              className={
                count > 0
                  ? "text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950"
                  : "text-gray-700 border-gray-200 bg-gray-50 dark:text-gray-300 dark:border-gray-800 dark:bg-gray-950"
              }
            >
              {count} {count === 1 ? "server" : "servers"}
            </Badge>
          );
        },
      },
      {
        accessorKey: "balanceAlgorithm",
        header: "Balance",
        cell: ({ row }) => (
          <BalanceBadge algorithm={row.original.balanceAlgorithm} />
        ),
      },
      {
        accessorKey: "sourceType",
        header: "Source",
        cell: ({ row }) => (
          <BackendSourceBadge sourceType={row.original.sourceType} />
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <BackendStatusBadge status={row.original.status} />
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const backend = row.original;

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="sm">
                  <IconDots className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(
                      `/haproxy/backends/${backend.name}?environmentId=${backend.environmentId}`,
                    );
                  }}
                >
                  <IconEye className="h-4 w-4 mr-2" />
                  View Details
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [navigate, environmentsById],
  );

  const table = useReactTable({
    data: filteredBackends,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

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
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconServer className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Backends</h1>
              <p className="text-muted-foreground">
                Manage HAProxy backend server groups
              </p>
            </div>
          </div>

          <div className="mt-6 p-4 border border-destructive/50 bg-destructive/10 rounded-md flex items-start gap-3">
            <IconAlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">
                Failed to load backends
              </p>
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
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconServer className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Backends</h1>
              <p className="text-muted-foreground">
                Manage HAProxy backend server groups and load balancing
              </p>
            </div>
          </div>

          <Button asChild>
            <Link to="/haproxy/frontends/new/manual">
              <IconPlus className="h-4 w-4 mr-2" />
              Connect Container
            </Link>
          </Button>
        </div>
      </div>

      {/* Filters Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Filter Backends</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Environment Filter */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Environment</label>
                <Select
                  value={environmentFilter}
                  onValueChange={setEnvironmentFilter}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Environments</SelectItem>
                    {environments.map((env) => (
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
                    <SelectItem value="removed">Removed</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Source Type Filter */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Source Type</label>
                <Select value={sourceFilter} onValueChange={setSourceFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sources</SelectItem>
                    <SelectItem value="deployment">Deployment</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Search */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Search</label>
                <div className="relative">
                  <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search backends..."
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

      {/* Backends Table */}
      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Backends ({filteredBackends.length})</CardTitle>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <IconRefresh className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {filteredBackends.length === 0 ? (
              <div className="text-center py-12">
                <IconServer className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-semibold">
                  No backends found
                </h3>
                <p className="mt-2 text-muted-foreground">
                  {backends.length === 0
                    ? "Backends are created automatically when deployments are configured."
                    : "Try adjusting your filters to see more results."}
                </p>
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
                                  header.getContext(),
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
                        onClick={() => navigate(`/haproxy/backends/${row.original.name}?environmentId=${row.original.environmentId}`)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
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
    </div>
  );
}

export default BackendsListPage;
