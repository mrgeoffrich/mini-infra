import { createBrowserRouter, Navigate } from "react-router-dom";
import { ProtectedRoute } from "@/components/protected-route";
import { PublicRoute } from "@/components/public-route";
import { AuthErrorBoundary } from "@/components/auth-error-boundary";
import { AppLayout } from "@/components/app-layout";
import { LoginPage } from "@/app/login/page";
import { DashboardPage } from "@/app/dashboard/page";
import { ContainersPage } from "@/app/containers/page";
import { SettingsPage } from "@/app/settings/page";

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
    path: "/",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <AppLayout />
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
    children: [
      {
        path: "dashboard",
        element: <DashboardPage />,
      },
      {
        path: "containers",
        element: <ContainersPage />,
      },
      {
        path: "databases",
        element: <div>Database Management - Coming Soon</div>,
      },
      {
        path: "deployments",
        element: <div>Deployment Management - Coming Soon</div>,
      },
      {
        path: "tunnels",
        element: <div>Cloudflare Tunnels - Coming Soon</div>,
      },
      {
        path: "logs",
        element: <div>Activity Logs - Coming Soon</div>,
      },
      {
        path: "settings",
        element: <Navigate to="/settings/overview" replace />,
      },
      {
        path: "settings/overview",
        element: <SettingsPage />,
      },
      {
        path: "settings/docker",
        element: <div>Docker Settings - Coming Soon</div>,
      },
      {
        path: "settings/cloudflare",
        element: <div>Cloudflare Settings - Coming Soon</div>,
      },
      {
        path: "settings/azure",
        element: <div>Azure Settings - Coming Soon</div>,
      },
      {
        path: "settings/audit",
        element: <div>Settings Audit - Coming Soon</div>,
      },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/dashboard" replace />,
  },
]);
