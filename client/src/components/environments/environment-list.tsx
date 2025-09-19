import { useState } from "react";
import { Environment } from "@mini-infra/types";
import { useEnvironments, useEnvironmentFilters } from "@/hooks/use-environments";
import { EnvironmentCard } from "./environment-card";
import { EnvironmentFilters } from "./environment-filters";
import { EnvironmentCreateDialog } from "./environment-create-dialog";
import { EnvironmentEditDialog } from "./environment-edit-dialog";
import { EnvironmentDeleteDialog } from "./environment-delete-dialog";
import { ServiceAddDialog } from "./service-add-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Plus, RefreshCw, Server, AlertCircle } from "lucide-react";

interface EnvironmentListProps {
  className?: string;
  onEnvironmentSelect?: (environmentId: string | null) => void;
}

export function EnvironmentList({ className, onEnvironmentSelect }: EnvironmentListProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [serviceAddDialogOpen, setServiceAddDialogOpen] = useState(false);
  const [selectedEnvironment, setSelectedEnvironment] = useState<Environment | null>(null);
  const [selectedEnvironmentForTabs, setSelectedEnvironmentForTabs] = useState<Environment | null>(null);

  const { filters, updateFilter, resetFilters } = useEnvironmentFilters();

  const {
    data: environmentsData,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useEnvironments({
    filters,
    refetchInterval: 10000, // Refetch every 10 seconds for real-time updates
  });

  const environments = environmentsData?.environments || [];
  const totalPages = environmentsData?.totalPages || 0;
  const hasNextPage = environmentsData?.hasNextPage || false;
  const hasPreviousPage = environmentsData?.hasPreviousPage || false;

  const handleEdit = (environment: Environment) => {
    setSelectedEnvironment(environment);
    setEditDialogOpen(true);
  };

  const handleDelete = (environment: Environment) => {
    setSelectedEnvironment(environment);
    setDeleteDialogOpen(true);
  };

  const handleAddService = (environment: Environment) => {
    setSelectedEnvironment(environment);
    setServiceAddDialogOpen(true);
  };

  const handleSelectForTabs = (environment: Environment) => {
    if (selectedEnvironmentForTabs?.id === environment.id) {
      // Deselect if clicking the same environment
      setSelectedEnvironmentForTabs(null);
      onEnvironmentSelect?.(null);
    } else {
      setSelectedEnvironmentForTabs(environment);
      onEnvironmentSelect?.(environment.id);
    }
  };

  const handleRefresh = () => {
    refetch();
  };

  const renderPagination = () => {
    if (totalPages <= 1) return null;

    const generatePageNumbers = () => {
      const pages = [];
      const currentPage = filters.page;

      // Always show first page
      pages.push(1);

      // Add ellipsis if there's a gap
      if (currentPage > 3) {
        pages.push('ellipsis-start');
      }

      // Add pages around current page
      for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
        if (!pages.includes(i)) {
          pages.push(i);
        }
      }

      // Add ellipsis if there's a gap
      if (currentPage < totalPages - 2) {
        pages.push('ellipsis-end');
      }

      // Always show last page if there's more than one page
      if (totalPages > 1 && !pages.includes(totalPages)) {
        pages.push(totalPages);
      }

      return pages;
    };

    return (
      <Pagination className="mt-6">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={() => updateFilter("page", filters.page - 1)}
              className={!hasPreviousPage ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>

          {generatePageNumbers().map((page, index) => (
            <PaginationItem key={index}>
              {page === 'ellipsis-start' || page === 'ellipsis-end' ? (
                <PaginationEllipsis />
              ) : (
                <PaginationLink
                  onClick={() => updateFilter("page", page as number)}
                  isActive={page === filters.page}
                  className="cursor-pointer"
                >
                  {page}
                </PaginationLink>
              )}
            </PaginationItem>
          ))}

          <PaginationItem>
            <PaginationNext
              onClick={() => updateFilter("page", filters.page + 1)}
              className={!hasNextPage ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    );
  };

  if (isError) {
    return (
      <div className={className}>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load environments: {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Header Actions */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setCreateDialogOpen(true)}
            className="flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            Create Environment
          </Button>
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={isRefetching}
            className="flex items-center gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <EnvironmentFilters
        filters={filters}
        onFilterChange={updateFilter}
        onResetFilters={resetFilters}
        className="mb-6"
      />

      {/* Content */}
      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-6 w-20" />
                  </div>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                  <div className="flex gap-2">
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="h-8 w-16" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : environments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Environments Found</h3>
            <p className="text-muted-foreground text-center mb-4">
              {Object.keys(filters).some(key => key !== 'page' && key !== 'limit' && filters[key as keyof typeof filters])
                ? "No environments match your current filters."
                : "Get started by creating your first environment."}
            </p>
            {Object.keys(filters).some(key => key !== 'page' && key !== 'limit' && filters[key as keyof typeof filters]) ? (
              <Button variant="outline" onClick={resetFilters}>
                Clear Filters
              </Button>
            ) : (
              <Button onClick={() => setCreateDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Environment
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {environments.map((environment) => (
              <EnvironmentCard
                key={environment.id}
                environment={environment}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onAddService={handleAddService}
                onSelect={handleSelectForTabs}
                isSelected={selectedEnvironmentForTabs?.id === environment.id}
              />
            ))}
          </div>
          {renderPagination()}
        </>
      )}

      {/* Dialogs */}
      <EnvironmentCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={() => refetch()}
      />

      {selectedEnvironment && (
        <>
          <EnvironmentEditDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            environment={selectedEnvironment}
            onSuccess={() => {
              refetch();
              setSelectedEnvironment(null);
            }}
          />

          <EnvironmentDeleteDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            environment={selectedEnvironment}
            onSuccess={() => {
              refetch();
              setSelectedEnvironment(null);
            }}
          />

          <ServiceAddDialog
            open={serviceAddDialogOpen}
            onOpenChange={setServiceAddDialogOpen}
            environment={selectedEnvironment}
            onSuccess={() => {
              refetch();
              setSelectedEnvironment(null);
            }}
          />
        </>
      )}
    </div>
  );
}