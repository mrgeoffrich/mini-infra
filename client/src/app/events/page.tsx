import { useState } from "react";
import { IconHistory, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useEvents, useEventFilters, useDeleteEvent } from "@/hooks/use-events";
import { EventsTable } from "@/components/events/EventsTable";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
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

export function EventsPage() {
  const { filters, updateFilter } = useEventFilters();
  const [eventToDelete, setEventToDelete] = useState<string | null>(null);

  // Fetch events with current filters
  const {
    data: eventsResponse,
    isLoading,
    error,
  } = useEvents({
    filters: {
      eventType: filters.eventType as any,
      eventCategory: filters.eventCategory as any,
      status: filters.status as any,
      search: filters.search,
      startDate: filters.startDate,
      endDate: filters.endDate,
    },
    page: filters.page,
    limit: filters.limit,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  const deleteEventMutation = useDeleteEvent();

  const events = eventsResponse?.data || [];
  const pagination = eventsResponse?.pagination;
  const totalPages = pagination
    ? Math.ceil(pagination.totalCount / pagination.limit)
    : 1;

  const handleDeleteEvent = (eventId: string) => {
    setEventToDelete(eventId);
  };

  const confirmDelete = async () => {
    if (!eventToDelete) return;

    try {
      await deleteEventMutation.mutateAsync(eventToDelete);
      toast.success("Event deleted successfully");
      setEventToDelete(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete event",
      );
    }
  };

  const handlePreviousPage = () => {
    if (filters.page > 1) {
      updateFilter("page", filters.page - 1);
    }
  };

  const handleNextPage = () => {
    if (filters.page < totalPages) {
      updateFilter("page", filters.page + 1);
    }
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Page Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconHistory className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Events</h1>
            <p className="text-muted-foreground">
              Track and monitor system operations and activities
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 lg:px-6">
        <div className="space-y-4">
            {/* Stats summary */}
            {pagination && (
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <div>
                  Showing {events.length === 0 ? 0 : pagination.offset + 1} to{" "}
                  {Math.min(
                    pagination.offset + pagination.limit,
                    pagination.totalCount,
                  )}{" "}
                  of {pagination.totalCount} events
                </div>
              </div>
            )}

            {/* Error State */}
            {error && (
              <div className="p-4 border border-destructive/50 bg-destructive/10 rounded-md">
                <p className="font-medium text-destructive">
                  Failed to load events
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {error instanceof Error ? error.message : "Unknown error"}
                </p>
              </div>
            )}

            {/* Events Table */}
            <EventsTable
              events={events}
              isLoading={isLoading}
              onDeleteEvent={handleDeleteEvent}
            />

            {/* Pagination */}
            {pagination && pagination.totalCount > pagination.limit && (
              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePreviousPage}
                  disabled={filters.page === 1 || isLoading}
                >
                  <IconChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <div className="text-sm text-muted-foreground">
                  Page {filters.page} of {totalPages}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={filters.page >= totalPages || isLoading}
                >
                  Next
                  <IconChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!eventToDelete} onOpenChange={() => setEventToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Event</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this event? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
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

export default EventsPage;
