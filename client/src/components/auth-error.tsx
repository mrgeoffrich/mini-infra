import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useState } from "react";

interface AuthError {
  message: string;
  code?: string;
  statusCode?: number;
}

interface AuthErrorDisplayProps {
  error: AuthError | string;
  onRetry?: () => void;
  onDismiss?: () => void;
  showCard?: boolean;
  variant?: "default" | "destructive";
  className?: string;
}

export function AuthErrorDisplay({
  error,
  onRetry,
  onDismiss,
  showCard = false,
  variant = "destructive",
  className = "",
}: AuthErrorDisplayProps) {
  const [isDismissed, setIsDismissed] = useState(false);

  if (isDismissed) {
    return null;
  }

  const errorMessage = typeof error === "string" ? error : error.message;
  const errorCode = typeof error === "object" ? error.code : undefined;
  const statusCode = typeof error === "object" ? error.statusCode : undefined;

  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss?.();
  };

  const getErrorTitle = () => {
    if (statusCode === 401) return "Authentication Failed";
    if (statusCode === 403) return "Access Denied";
    if (statusCode === 429) return "Rate Limited";
    if (statusCode && statusCode >= 500) return "Server Error";
    return "Authentication Error";
  };

  const getHelpText = () => {
    if (statusCode === 401)
      return "Please check your credentials and try again.";
    if (statusCode === 403)
      return "You don't have permission to access this resource.";
    if (statusCode === 429)
      return "Too many attempts. Please wait a moment and try again.";
    if (statusCode && statusCode >= 500)
      return "Our servers are experiencing issues. Please try again later.";
    return "Something went wrong with authentication. Please try again.";
  };

  const errorContent = (
    <Alert variant={variant} className={className}>
      <AlertTriangle className="h-4 w-4" />
      <div className="flex-1">
        <AlertTitle className="flex items-center justify-between">
          {getErrorTitle()}
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              className="h-auto p-1"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </AlertTitle>
        <AlertDescription className="mt-2">
          <div className="space-y-2">
            <p>{errorMessage}</p>
            <p className="text-sm text-muted-foreground">{getHelpText()}</p>
            {errorCode && (
              <p className="text-xs text-muted-foreground">
                Error Code: {errorCode}
                {statusCode && ` (${statusCode})`}
              </p>
            )}
            {onRetry && (
              <div className="flex gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  className="h-8"
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  Try Again
                </Button>
              </div>
            )}
          </div>
        </AlertDescription>
      </div>
    </Alert>
  );

  if (!showCard) {
    return errorContent;
  }

  return (
    <Card className="border-destructive">
      <CardHeader className="pb-3">
        <CardTitle className="text-destructive flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          {getErrorTitle()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <p>{errorMessage}</p>
          <p className="text-sm text-muted-foreground">{getHelpText()}</p>
          {errorCode && (
            <p className="text-xs text-muted-foreground">
              Error Code: {errorCode}
              {statusCode && ` (${statusCode})`}
            </p>
          )}
          <div className="flex gap-2 mt-4">
            {onRetry && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRetry}
                className="h-8"
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Try Again
              </Button>
            )}
            {onDismiss && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDismiss}
                className="h-8"
              >
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function InlineAuthError({
  error,
  onRetry,
}: {
  error: AuthError | string;
  onRetry?: () => void;
}) {
  const errorMessage = typeof error === "string" ? error : error.message;

  return (
    <div className="flex items-center gap-2 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4" />
      <span>{errorMessage}</span>
      {onRetry && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="h-auto p-1 text-xs"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
