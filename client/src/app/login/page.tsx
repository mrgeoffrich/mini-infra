import { LoginForm } from "@/components/login-form";
import { AuthErrorDisplay } from "@/components/auth-error";
import { useSearchParams, Navigate } from "react-router-dom";
import { useState } from "react";
import { useSetupStatus } from "@/hooks/use-setup-status";

function getAuthErrorFromParams(
  searchParams: URLSearchParams,
): string | null {
  const authParam = searchParams.get("auth");
  if (authParam === "error") return "Authentication failed. Please try again.";
  if (authParam === "google-not-enabled")
    return "Google OAuth is not enabled. Please use email and password.";
  if (authParam === "google-not-configured")
    return "Google OAuth is not properly configured.";
  return null;
}

export function LoginPage() {
  const [searchParams] = useSearchParams();
  // Initialize the error from URL params; the user can dismiss it via setAuthError(null).
  const [authError, setAuthError] = useState<string | null>(() =>
    getAuthErrorFromParams(searchParams),
  );
  const { data: setupStatus, isLoading } = useSetupStatus();

  // Redirect to setup if not yet set up
  if (!isLoading && setupStatus && !setupStatus.setupComplete) {
    return <Navigate to="/setup" replace />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-4">
        {authError && (
          <AuthErrorDisplay
            error={authError}
            onDismiss={() => setAuthError(null)}
            variant="destructive"
          />
        )}
        <LoginForm />
      </div>
    </div>
  );
}
