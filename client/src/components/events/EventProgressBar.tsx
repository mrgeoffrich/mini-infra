import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { IconLoader } from "@tabler/icons-react";
import { UserEventInfo } from "@mini-infra/types";

interface EventProgressBarProps {
  event: UserEventInfo;
}

export function EventProgressBar({ event }: EventProgressBarProps) {
  if (event.status !== "running" && event.status !== "pending") {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconLoader className="h-5 w-5 animate-spin" />
          Operation in Progress
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium">{event.progress}%</span>
          </div>
          <Progress value={event.progress} className="h-3" />
        </div>

        <div className="text-sm text-muted-foreground">
          {event.progress === 0 && <p>Operation has not started yet...</p>}
          {event.progress > 0 && event.progress < 25 && (
            <p>Operation is initializing...</p>
          )}
          {event.progress >= 25 && event.progress < 50 && (
            <p>Operation is in progress...</p>
          )}
          {event.progress >= 50 && event.progress < 75 && (
            <p>Operation is more than halfway complete...</p>
          )}
          {event.progress >= 75 && event.progress < 100 && (
            <p>Operation is almost complete...</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
