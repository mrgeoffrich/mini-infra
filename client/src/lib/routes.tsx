import { createBrowserRouter, Navigate } from "react-router-dom";
import { ProtectedRoute } from "@/components/protected-route";
import { PublicRoute } from "@/components/public-route";
import { AuthErrorBoundary } from "@/components/auth-error-boundary";
import { LoginPage } from "@/app/login/page";
import { DashboardPage } from "@/app/dashboard/page";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate to="/dashboard" replace />,
  },
  {
    path: "/login",
    element: (
      <AuthErrorBoundary>
        <PublicRoute restricted>
          <LoginPage />
        </PublicRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/dashboard",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <DashboardPage />
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  // Future routes can be added here
  {
    path: "/containers",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <div>Container Management - Coming Soon</div>
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/databases",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <div>Database Management - Coming Soon</div>
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/deployments",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <div>Deployment Management - Coming Soon</div>
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/tunnels",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <div>Cloudflare Tunnels - Coming Soon</div>
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/logs",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <div>Activity Logs - Coming Soon</div>
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/settings",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <div>Settings - Coming Soon</div>
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "*",
    element: <Navigate to="/dashboard" replace />,
  },
]);
