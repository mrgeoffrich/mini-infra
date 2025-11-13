import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IconAlertCircle } from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { UserEventInfo } from "@mini-infra/types";

interface EventErrorCardProps {
  event: UserEventInfo;
}

export function EventErrorCard({ event }: EventErrorCardProps) {
  if (event.status !== "failed" || !event.errorMessage) {
    return null;
  }

  return (
    <Card className="border-destructive">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <IconAlertCircle className="h-5 w-5" />
          Error Details
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error Message */}
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{event.errorMessage}</AlertDescription>
        </Alert>

        {/* Error Details */}
        {event.errorDetails && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">Technical Details</p>
              <pre className="text-xs bg-destructive/10 p-3 rounded-md overflow-x-auto border border-destructive/20">
                {typeof event.errorDetails === "string"
                  ? event.errorDetails
                  : JSON.stringify(event.errorDetails, null, 2)}
              </pre>
            </div>
          </>
        )}

        {/* Troubleshooting Tips */}
        <Separator />
        <div className="space-y-2">
          <p className="text-sm font-medium">Troubleshooting</p>
          <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
            <li>Check the logs above for more detailed information</li>
            <li>Verify that all required resources are available</li>
            <li>Ensure proper permissions are configured</li>
            <li>Check system logs for related errors</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
