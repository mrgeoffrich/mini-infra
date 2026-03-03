import { LoginForm } from "@/components/login-form";
import { AuthErrorDisplay } from "@/components/auth-error";
import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    // Check for authentication error in URL
    const authParam = searchParams.get("auth");
    if (authParam === "error") {
      setAuthError("Authentication failed. Please try again.");
    }
  }, [searchParams]);

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
