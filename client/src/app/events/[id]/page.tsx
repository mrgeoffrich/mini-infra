import { useParams, useNavigate } from "react-router-dom";
import {
  IconArrowLeft,
  IconRefresh,
  IconTrash,
  IconAlertCircle,
} from "@tabler/icons-react";
import { useEvent, useDeleteEvent } from "@/hooks/use-events";
import { EventMetadataCard } from "@/components/events/EventMetadataCard";
import { EventLogsViewer } from "@/components/events/EventLogsViewer";
import { EventProgressBar } from "@/components/events/EventProgressBar";
import { EventErrorCard } from "@/components/events/EventErrorCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useState } from "react";

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const {
    data: eventResponse,
    isLoading,
    error,
    refetch,
  } = useEvent(id || "", {
    enabled: !!id,
  });

  const deleteEventMutation = useDeleteEvent();

  const event = eventResponse?.data;

  const handleDelete = async () => {
    if (!id) return;

    try {
      await deleteEventMutation.mutateAsync(id);
      toast.success("Event deleted successfully");
      navigate("/events");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete event",
      );
    }
  };

  const handleBack = () => {
    navigate("/events");
  };

  const handleRefresh = () => {
    refetch();
    toast.info("Refreshing event data...");
  };

  // Loading State
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-10 w-48" />
        </div>
        <div className="px-4 lg:px-6 space-y-6">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  // Error State
  if (error || !event) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button variant="ghost" onClick={handleBack}>
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back to Events
          </Button>
        </div>
        <div className="px-4 lg:px-6">
          <div className="p-8 border border-destructive/50 bg-destructive/10 rounded-md flex flex-col items-center gap-3">
            <IconAlertCircle className="h-12 w-12 text-destructive" />
            <div className="text-center">
              <p className="font-medium text-destructive">Failed to load event</p>
              <p className="text-sm text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Event not found"}
              </p>
            </div>
            <Button onClick={handleBack}>Back to Events</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={handleBack}>
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back to Events
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={deleteEventMutation.isPending}
            >
              <IconRefresh className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDeleteDialog(true)}
              disabled={deleteEventMutation.isPending}
            >
              <IconTrash className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 lg:px-6 space-y-6">
        {/* Progress Bar (only shown if running/pending) */}
        <EventProgressBar event={event} />

        {/* Error Card (only shown if failed) */}
        <EventErrorCard event={event} />

        {/* Metadata Card */}
        <EventMetadataCard event={event} />

        {/* Logs Viewer */}
        <EventLogsViewer logs={event.logs} eventName={event.eventName} />
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
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
              onClick={handleDelete}
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

export default EventDetailPage;
