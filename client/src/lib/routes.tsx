import { createBrowserRouter, Navigate } from "react-router-dom";
import { ProtectedRoute } from "@/components/protected-route";
import { PublicRoute } from "@/components/public-route";
import { AuthErrorBoundary } from "@/components/auth-error-boundary";
import { AppLayout } from "@/components/app-layout";
import { LoginPage } from "@/app/login/page";
import { DashboardPage } from "@/app/dashboard/page";
import { ContainersPage } from "@/app/containers/page";
import { SettingsPage } from "@/app/settings/page";
import DockerSettingsPage from "@/app/settings/docker/page";
import CloudflareSettingsPage from "@/app/settings/cloudflare/page";
import AzureSettingsPage from "@/app/settings/azure/page";
import SystemSettingsPage from "@/app/settings/system/page";
import PostgresPage from "@/app/postgres/page";
import { TunnelsPage } from "@/app/tunnels/page";
import { UserSettingsPage } from "@/app/user/settings/page";

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
        path: "postgres",
        element: <PostgresPage />,
      },
      {
        path: "deployments",
        element: <div>Deployment Management - Coming Soon</div>,
      },
      {
        path: "tunnels",
        element: <TunnelsPage />,
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
        element: <DockerSettingsPage />,
      },
      {
        path: "settings/cloudflare",
        element: <CloudflareSettingsPage />,
      },
      {
        path: "settings/azure",
        element: <AzureSettingsPage />,
      },
      {
        path: "settings/system",
        element: <SystemSettingsPage />,
      },
      {
        path: "user/settings",
        element: <UserSettingsPage />,
      },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/dashboard" replace />,
  },
]);
