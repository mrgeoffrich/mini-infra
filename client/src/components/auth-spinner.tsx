import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface AuthSpinnerProps {
  message?: string;
  showCard?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function AuthSpinner({
  message = "Loading...",
  showCard = true,
  size = "md",
  className = "",
}: AuthSpinnerProps) {
  const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
  };

  const textSizeClasses = {
    sm: "text-sm",
    md: "text-base",
    lg: "text-lg",
  };

  const spinnerContent = (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${className}`}
    >
      <Loader2
        className={`${sizeClasses[size]} animate-spin text-muted-foreground`}
      />
      <p
        className={`${textSizeClasses[size]} text-muted-foreground text-center`}
      >
        {message}
      </p>
    </div>
  );

  if (!showCard) {
    return spinnerContent;
  }

  return (
    <Card>
      <CardContent className="py-8">{spinnerContent}</CardContent>
    </Card>
  );
}

export function FullPageAuthSpinner({
  message = "Authenticating...",
}: {
  message?: string;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <AuthSpinner message={message} size="lg" showCard={false} />
    </div>
  );
}

export function InlineAuthSpinner({
  message = "Loading...",
  size = "sm",
}: {
  message?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className="flex items-center gap-2">
      <Loader2
        className={`${size === "sm" ? "h-4 w-4" : "h-5 w-5"} animate-spin`}
      />
      <span className={size === "sm" ? "text-sm" : "text-base"}>{message}</span>
    </div>
  );
}
