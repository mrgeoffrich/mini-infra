import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AzureContainerPaginationProps {
  currentPage: number;
  totalPages: number;
  totalCount: number;
  startItem: number;
  endItem: number;
  onPageChange: (page: number) => void;
}

export const AzureContainerPagination = React.memo(
  ({
    currentPage,
    totalPages,
    totalCount,
    startItem,
    endItem,
    onPageChange,
  }: AzureContainerPaginationProps) => {
    if (totalPages <= 1) {
      return null;
    }

    return (
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {startItem} to {endItem} of {totalCount} containers
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>

          <div className="flex items-center gap-1">
            {totalPages <= 7 ? (
              // Show all pages if there are 7 or fewer
              Array.from({ length: totalPages }, (_, i) => i + 1).map(
                (pageNum) => (
                  <Button
                    key={pageNum}
                    variant={currentPage === pageNum ? "default" : "outline"}
                    size="sm"
                    onClick={() => onPageChange(pageNum)}
                    className="w-8"
                  >
                    {pageNum}
                  </Button>
                ),
              )
            ) : (
              // Show abbreviated pagination for more than 7 pages
              <>
                {currentPage > 3 && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onPageChange(1)}
                      className="w-8"
                    >
                      1
                    </Button>
                    {currentPage > 4 && (
                      <span className="text-muted-foreground">...</span>
                    )}
                  </>
                )}

                {Array.from(
                  { length: Math.min(5, totalPages) },
                  (_, i) =>
                    Math.max(
                      1,
                      Math.min(currentPage - 2, totalPages - 4),
                    ) + i,
                )
                  .filter((pageNum) => pageNum <= totalPages)
                  .map((pageNum) => (
                    <Button
                      key={pageNum}
                      variant={currentPage === pageNum ? "default" : "outline"}
                      size="sm"
                      onClick={() => onPageChange(pageNum)}
                      className="w-8"
                    >
                      {pageNum}
                    </Button>
                  ))}

                {currentPage < totalPages - 2 && (
                  <>
                    {currentPage < totalPages - 3 && (
                      <span className="text-muted-foreground">...</span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onPageChange(totalPages)}
                      className="w-8"
                    >
                      {totalPages}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  },
);

AzureContainerPagination.displayName = "AzureContainerPagination";
