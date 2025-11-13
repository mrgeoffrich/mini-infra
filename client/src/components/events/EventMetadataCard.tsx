import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IconInfoCircle } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { UserEventInfo } from "@mini-infra/types";
import { EventStatusBadge } from "./EventStatusBadge";
import { EventTypeBadge, EventCategoryBadge } from "./EventTypeBadge";
import { Progress } from "@/components/ui/progress";

interface EventMetadataCardProps {
  event: UserEventInfo;
}

export function EventMetadataCard({ event }: EventMetadataCardProps) {
  const { formatDateTime } = useFormattedDate();

  const formatDuration = (durationMs: number | null) => {
    if (!durationMs) return null;

    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 60) {
      return `${seconds} seconds`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-2xl">{event.eventName}</CardTitle>
            {event.description && (
              <p className="text-sm text-muted-foreground">{event.description}</p>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status and Progress */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <EventStatusBadge status={event.status} />
            <EventTypeBadge eventType={event.eventType} eventCategory={event.eventCategory} />
            <EventCategoryBadge category={event.eventCategory} />
          </div>
          {(event.status === "running" || event.status === "pending") && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">{event.progress}%</span>
              </div>
              <Progress value={event.progress} className="h-2" />
            </div>
          )}
        </div>

        <Separator />

        {/* Details Grid */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">Triggered By</p>
            <p className="text-sm capitalize">{event.triggeredBy}</p>
            {event.user && (
              <p className="text-xs text-muted-foreground">
                {event.user.name || event.user.email}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">Started At</p>
            <p className="text-sm">{formatDateTime(event.startedAt)}</p>
          </div>

          {event.completedAt && (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Completed At</p>
              <p className="text-sm">{formatDateTime(event.completedAt)}</p>
            </div>
          )}

          {event.durationMs !== null && (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Duration</p>
              <p className="text-sm">{formatDuration(event.durationMs)}</p>
            </div>
          )}
        </div>

        {/* Resource Info */}
        {(event.resourceType || event.resourceName || event.resourceId) && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-2">
                <IconInfoCircle className="h-4 w-4" />
                Resource Information
              </p>
              <div className="grid grid-cols-2 gap-4">
                {event.resourceType && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">Type</p>
                    <Badge variant="outline" className="capitalize">
                      {event.resourceType.replace("_", " ")}
                    </Badge>
                  </div>
                )}
                {event.resourceName && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">Name</p>
                    <p className="text-sm">{event.resourceName}</p>
                  </div>
                )}
                {event.resourceId && (
                  <div className="space-y-1 col-span-2">
                    <p className="text-sm font-medium text-muted-foreground">ID</p>
                    <p className="text-xs font-mono text-muted-foreground">{event.resourceId}</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Result Summary */}
        {event.resultSummary && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">Result Summary</p>
              <p className="text-sm text-muted-foreground">{event.resultSummary}</p>
            </div>
          </>
        )}

        {/* Metadata JSON */}
        {event.metadata && Object.keys(event.metadata).length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">Metadata</p>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto">
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
