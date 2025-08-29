import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { AuthSpinner } from "@/components/auth-spinner";

interface PublicRouteProps {
  children: ReactNode;
  restricted?: boolean; // If true, authenticated users will be redirected away
  fallback?: ReactNode;
}

export function PublicRoute({
  children,
  restricted = false,
  fallback,
}: PublicRouteProps) {
  const { authState } = useAuth();
  const location = useLocation();

  // Show loading spinner while checking authentication
  if (authState.isLoading) {
    return fallback || <AuthSpinner />;
  }

  // If this is a restricted public route (like login page) and user is authenticated,
  // redirect them to the dashboard or their intended destination
  if (restricted && authState.isAuthenticated) {
    const from = location.state?.from || "/dashboard";
    return <Navigate to={from} replace />;
  }

  // Render the public content
  return <>{children}</>;
}
