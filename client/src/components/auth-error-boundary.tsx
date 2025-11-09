import { Component, ErrorInfo, ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class AuthErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Authentication error caught by boundary:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
    // Reload the page to retry authentication
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-4">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                <IconAlertTriangle className="h-6 w-6 text-destructive" />
              </div>
              <CardTitle className="text-lg">Authentication Error</CardTitle>
              <CardDescription>
                Something went wrong with the authentication system. Please try
                again.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {this.state.error && (
                <div className="rounded-md bg-destructive/10 p-3">
                  <p className="text-sm text-destructive font-medium">
                    Error Details:
                  </p>
                  <p className="text-xs text-destructive/80 mt-1">
                    {this.state.error.message}
                  </p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button onClick={this.handleRetry} className="w-full">
                  <IconRefresh className="mr-2 h-4 w-4" />
                  Try Again
                </Button>
                <Button
                  variant="outline"
                  onClick={() => (window.location.href = "/login")}
                  className="w-full"
                >
                  Go to Login
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
