import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { AuthSpinner } from "@/components/auth-spinner";
import { AuthErrorDisplay } from "@/components/auth-error";

interface ProtectedRouteProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function ProtectedRoute({ children, fallback }: ProtectedRouteProps) {
  const { authState } = useAuth();
  const location = useLocation();

  // Show loading spinner while checking authentication
  if (authState.isLoading) {
    return fallback || <AuthSpinner />;
  }

  // Show error if authentication check failed
  if (authState.error) {
    return <AuthErrorDisplay error={authState.error} showCard />;
  }

  // Redirect to login if not authenticated
  if (!authState.isAuthenticated) {
    return (
      <Navigate
        to="/login"
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  }

  // Force password change if required
  if (authState.mustResetPwd && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  // User is authenticated, render the protected content
  return <>{children}</>;
}
