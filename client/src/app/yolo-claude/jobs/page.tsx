import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  Plus,
  RefreshCw,
  Clock,
  Play,
  CheckCircle,
  XCircle,
  Square,
  AlertCircle,
  ExternalLink,
  Eye,
  Github,
  Calendar,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useJobs, useJobFilters } from "@/hooks/use-jobs";
import { JobStatus, JobResponse } from "@mini-infra/types";
import { formatDistanceToNow, format } from "date-fns";

export default function JobListPage() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState("");

  // Job filters and pagination
  const { filters, updateFilter, resetFilters } = useJobFilters({
    page: 1,
    limit: 20,
    sortBy: "createdAt",
    sortOrder: "desc",
  });

  // Fetch jobs with current filters
  const {
    data: jobsResponse,
    isLoading,
    error,
    refetch,
  } = useJobs({
    page: filters.page,
    limit: filters.limit,
    search: filters.search,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  const jobs = jobsResponse?.data || [];
  const totalJobs = jobsResponse?.totalCount || 0;
  const totalPages = Math.ceil(totalJobs / filters.limit);

  // Handle search input changes
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateFilter("search", searchInput || undefined);
  };

  // Handle pagination
  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      updateFilter("page", newPage);
    }
  };

  // Get status badge display properties
  const getStatusDisplay = (status: JobStatus) => {
    switch (status) {
      case JobStatus.PENDING:
        return {
          variant: "secondary" as const,
          icon: <Clock className="h-3 w-3" />,
          label: "Pending",
          className: "bg-yellow-100 text-yellow-800 hover:bg-yellow-200",
        };
      case JobStatus.IN_PROGRESS:
        return {
          variant: "default" as const,
          icon: <Play className="h-3 w-3" />,
          label: "Running",
          className: "bg-blue-100 text-blue-800 hover:bg-blue-200",
        };
      case JobStatus.COMPLETED:
        return {
          variant: "default" as const,
          icon: <CheckCircle className="h-3 w-3" />,
          label: "Completed",
          className: "bg-green-100 text-green-800 hover:bg-green-200",
        };
      case JobStatus.FAILED:
        return {
          variant: "destructive" as const,
          icon: <XCircle className="h-3 w-3" />,
          label: "Failed",
        };
      case JobStatus.CANCELLED:
        return {
          variant: "secondary" as const,
          icon: <Square className="h-3 w-3" />,
          label: "Cancelled",
        };
      default:
        return {
          variant: "secondary" as const,
          icon: <AlertCircle className="h-3 w-3" />,
          label: "Unknown",
        };
    }
  };

  // Extract repository name from URL
  const getRepositoryName = (url: string) => {
    try {
      const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (match) {
        return `${match[1]}/${match[2]}`;
      }
      return url.replace(/^https?:\/\/(www\.)?/, "");
    } catch {
      return url;
    }
  };

  // Navigate to job creation
  const handleCreateNewJob = () => {
    navigate("/yolo-claude");
  };

  // Navigate to job execution view
  const handleViewJob = (jobId: string) => {
    navigate(`/yolo-claude/jobs/${jobId}`);
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300">
              <Github className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Job History</h1>
              <p className="text-muted-foreground">
                View and manage your Claude Code execution jobs
              </p>
            </div>
          </div>

          <Button onClick={handleCreateNewJob}>
            <Plus className="h-4 w-4 mr-2" />
            New Job
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl mx-auto w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  Job History
                  {totalJobs > 0 && (
                    <Badge variant="secondary">{totalJobs} jobs</Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  Track the status and progress of your story implementation
                  jobs
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4 mb-6">
              <form onSubmit={handleSearchSubmit} className="flex gap-2 flex-1">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by repository URL or story file..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Button type="submit" variant="outline">
                  Search
                </Button>
              </form>

              <div className="flex gap-2">
                <Select
                  value={filters.status || "all"}
                  onValueChange={(value) =>
                    updateFilter(
                      "status",
                      value === "all" ? undefined : (value as JobStatus),
                    )
                  }
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value={JobStatus.PENDING}>Pending</SelectItem>
                    <SelectItem value={JobStatus.IN_PROGRESS}>
                      Running
                    </SelectItem>
                    <SelectItem value={JobStatus.COMPLETED}>
                      Completed
                    </SelectItem>
                    <SelectItem value={JobStatus.FAILED}>Failed</SelectItem>
                    <SelectItem value={JobStatus.CANCELLED}>
                      Cancelled
                    </SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={`${filters.sortBy}-${filters.sortOrder}`}
                  onValueChange={(value) => {
                    const [sortBy, sortOrder] = value.split("-") as [
                      string,
                      "asc" | "desc",
                    ];
                    updateFilter("sortBy", sortBy);
                    updateFilter("sortOrder", sortOrder);
                  }}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="createdAt-desc">Newest First</SelectItem>
                    <SelectItem value="createdAt-asc">Oldest First</SelectItem>
                    <SelectItem value="status-asc">Status A-Z</SelectItem>
                    <SelectItem value="status-desc">Status Z-A</SelectItem>
                  </SelectContent>
                </Select>

                {(filters.search || filters.status) && (
                  <Button variant="outline" onClick={resetFilters}>
                    Clear
                  </Button>
                )}
              </div>
            </div>

            {/* Error State */}
            {error && (
              <Alert variant="destructive" className="mb-6">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Failed to load jobs: {error.message}
                </AlertDescription>
              </Alert>
            )}

            {/* Loading State */}
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>Loading jobs...</span>
                </div>
              </div>
            )}

            {/* Empty State */}
            {!isLoading && jobs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Github className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No jobs found</h3>
                <p className="text-muted-foreground mb-6 max-w-md">
                  {filters.search || filters.status
                    ? "No jobs match your current filters. Try adjusting your search criteria."
                    : "You haven't created any jobs yet. Start by creating your first Claude Code execution job."}
                </p>
                <Button onClick={handleCreateNewJob}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create First Job
                </Button>
              </div>
            )}

            {/* Jobs Table */}
            {!isLoading && jobs.length > 0 && (
              <>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Repository</TableHead>
                        <TableHead>Story File</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead className="w-[100px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.map((job: JobResponse) => {
                        const statusDisplay = getStatusDisplay(job.status);
                        const repoName = getRepositoryName(job.repositoryUrl);

                        return (
                          <TableRow key={job.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Github className="h-4 w-4 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <div className="font-mono text-sm truncate">
                                    {repoName}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {job.branchPrefix || "story"}
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="font-mono text-sm">
                                {job.storyFile}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={statusDisplay.variant}
                                className={cn(statusDisplay.className)}
                              >
                                {statusDisplay.icon}
                                <span className="ml-1">
                                  {statusDisplay.label}
                                </span>
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">
                                {formatDistanceToNow(new Date(job.createdAt), {
                                  addSuffix: true,
                                })}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {format(
                                  new Date(job.createdAt),
                                  "MMM d, HH:mm",
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">
                                {formatDistanceToNow(new Date(job.updatedAt), {
                                  addSuffix: true,
                                })}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {format(
                                  new Date(job.updatedAt),
                                  "MMM d, HH:mm",
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleViewJob(job.id)}
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    window.open(job.repositoryUrl, "_blank")
                                  }
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-6">
                    <div className="text-sm text-muted-foreground">
                      Showing {(filters.page - 1) * filters.limit + 1} to{" "}
                      {Math.min(filters.page * filters.limit, totalJobs)} of{" "}
                      {totalJobs} jobs
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(filters.page - 1)}
                        disabled={filters.page <= 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Previous
                      </Button>
                      <div className="flex items-center gap-1">
                        {Array.from({ length: Math.min(5, totalPages) }).map(
                          (_, i) => {
                            const page = i + 1;
                            const isCurrentPage = page === filters.page;
                            return (
                              <Button
                                key={page}
                                variant={isCurrentPage ? "default" : "outline"}
                                size="sm"
                                onClick={() => handlePageChange(page)}
                                className="w-8"
                              >
                                {page}
                              </Button>
                            );
                          },
                        )}
                        {totalPages > 5 && (
                          <>
                            <span className="px-2">...</span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handlePageChange(totalPages)}
                              className="w-8"
                            >
                              {totalPages}
                            </Button>
                          </>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(filters.page + 1)}
                        disabled={filters.page >= totalPages}
                      >
                        Next
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
