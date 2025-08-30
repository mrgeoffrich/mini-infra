"use client";

import { useState, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Download,
  Filter,
  Search,
} from "lucide-react";
import { format } from "date-fns";
import { useSettingsAudit, useAuditFilters } from "@/hooks/use-settings";

export default function SettingsAuditPage() {
  const { filters, updateFilter, resetFilters } = useAuditFilters();
  const [searchTerm, setSearchTerm] = useState("");

  const {
    data: auditData,
    isLoading,
    error,
    refetch,
  } = useSettingsAudit({
    filters: {
      category: filters.category,
      action: filters.action,
      userId: filters.userId,
      startDate: filters.startDate,
      endDate: filters.endDate,
      success: filters.success,
    },
    page: filters.page,
    limit: filters.limit,
  });

  const [isExporting, setIsExporting] = useState(false);

  // Filter audit entries based on search term
  const filteredAuditEntries = useMemo(() => {
    if (!auditData?.data || !searchTerm) {
      return auditData?.data || [];
    }

    const term = searchTerm.toLowerCase();
    return auditData.data.filter(
      (entry) =>
        entry.category.toLowerCase().includes(term) ||
        entry.key.toLowerCase().includes(term) ||
        entry.action.toLowerCase().includes(term) ||
        entry.userId.toLowerCase().includes(term) ||
        (entry.errorMessage && entry.errorMessage.toLowerCase().includes(term)),
    );
  }, [auditData?.data, searchTerm]);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      // Create CSV export of audit data
      const csvContent = auditData?.data
        ?.map((entry) => [
          format(new Date(entry.createdAt), "yyyy-MM-dd HH:mm:ss"),
          entry.category,
          entry.key,
          entry.action,
          entry.userId,
          entry.success ? "Success" : "Failed",
          entry.errorMessage || "",
        ])
        .join("\n");

      const headers = "Date,Category,Key,Action,User,Status,Error\n";
      const csv = headers + (csvContent || "");

      const blob = new Blob([csv], { type: "text/csv" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `settings-audit-${format(new Date(), "yyyy-MM-dd")}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  const getActionBadgeVariant = (action: string) => {
    switch (action) {
      case "create":
        return "default";
      case "update":
        return "secondary";
      case "delete":
        return "destructive";
      case "validate":
        return "outline";
      default:
        return "outline";
    }
  };

  const getStatusBadgeVariant = (success: boolean) => {
    return success ? "default" : "destructive";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Settings Audit Log
        </h1>
        <p className="text-muted-foreground">
          Track all configuration changes with detailed audit trail
        </p>
      </div>

      {/* Filters Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filters
          </CardTitle>
          <CardDescription>
            Filter audit entries by category, action type, user, and date range
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="text-sm font-medium">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search audit entries..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">Category</label>
              <Select
                value={filters.category || "all"}
                onValueChange={(value) =>
                  updateFilter("category", value === "all" ? undefined : (value as any))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  <SelectItem value="docker">Docker</SelectItem>
                  <SelectItem value="cloudflare">Cloudflare</SelectItem>
                  <SelectItem value="azure">Azure</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium">Action</label>
              <Select
                value={filters.action || "all"}
                onValueChange={(value) =>
                  updateFilter("action", value === "all" ? undefined : (value as any))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  <SelectItem value="create">Create</SelectItem>
                  <SelectItem value="update">Update</SelectItem>
                  <SelectItem value="delete">Delete</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium">User</label>
              <Input
                placeholder="User ID"
                value={filters.userId || ""}
                onChange={(e) => updateFilter("userId", e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-between items-center mt-4">
            <Button variant="outline" onClick={resetFilters}>
              Clear Filters
            </Button>
            <Button
              onClick={handleExport}
              disabled={isExporting || !auditData?.data?.length}
            >
              <Download className="h-4 w-4 mr-2" />
              {isExporting ? "Exporting..." : "Export CSV"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Audit Entries Table */}
      <Card>
        <CardHeader>
          <CardTitle>Audit Entries</CardTitle>
          <CardDescription>
            {auditData?.totalCount ? (
              <>
                Showing {filteredAuditEntries.length} of {auditData.totalCount}{" "}
                entries{searchTerm && ` (filtered by: "${searchTerm}")`}
              </>
            ) : (
              "No audit entries found"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-16 bg-muted rounded animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <p className="text-destructive mb-4">
                Failed to load audit entries
              </p>
              <Button onClick={() => refetch()} variant="outline">
                Try Again
              </Button>
            </div>
          ) : !filteredAuditEntries.length ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground mb-4">
                {searchTerm
                  ? `No audit entries match "${searchTerm}"`
                  : "No audit entries found"}
              </p>
              <Button onClick={() => refetch()} variant="outline">
                Refresh
              </Button>
            </div>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAuditEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        {format(
                          new Date(entry.createdAt),
                          "MMM dd, yyyy HH:mm:ss",
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{entry.category}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {entry.key}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getActionBadgeVariant(entry.action)}>
                          {entry.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{entry.userId}</TableCell>
                      <TableCell>
                        <Badge variant={getStatusBadgeVariant(entry.success)}>
                          {entry.success ? "Success" : "Failed"}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-xs">
                        {entry.errorMessage && (
                          <p
                            className="text-sm text-destructive truncate"
                            title={entry.errorMessage}
                          >
                            {entry.errorMessage}
                          </p>
                        )}
                        {entry.ipAddress && (
                          <p className="text-xs text-muted-foreground">
                            IP: {entry.ipAddress}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination */}
          {auditData?.totalPages && auditData.totalPages > 1 && (
            <div className="flex justify-between items-center mt-4">
              <p className="text-sm text-muted-foreground">
                Page {filters.page || 1} of {auditData.totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!auditData.hasPreviousPage}
                  onClick={() => updateFilter("page", (filters.page || 1) - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!auditData.hasNextPage}
                  onClick={() => updateFilter("page", (filters.page || 1) + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
