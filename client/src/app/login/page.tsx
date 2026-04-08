import { LoginForm } from "@/components/login-form";
import { AuthErrorDisplay } from "@/components/auth-error";
import { useSearchParams, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useSetupStatus } from "@/hooks/use-setup-status";

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [authError, setAuthError] = useState<string | null>(null);
  const { data: setupStatus, isLoading } = useSetupStatus();

  useEffect(() => {
    const authParam = searchParams.get("auth");
    if (authParam === "error") {
      setAuthError("Authentication failed. Please try again.");
    } else if (authParam === "google-not-enabled") {
      setAuthError("Google OAuth is not enabled. Please use email and password.");
    } else if (authParam === "google-not-configured") {
      setAuthError("Google OAuth is not properly configured.");
    }
  }, [searchParams]);

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
