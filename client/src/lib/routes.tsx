import { createBrowserRouter, Navigate } from "react-router-dom";
import { ProtectedRoute } from "@/components/protected-route";
import { PublicRoute } from "@/components/public-route";
import { AuthErrorBoundary } from "@/components/auth-error-boundary";
import { AppLayout } from "@/components/app-layout";
import { LoginPage } from "@/app/login/page";
import { DashboardPage } from "@/app/dashboard/page";
import { ContainersPage } from "@/app/containers/page";
import DockerSettingsPage from "@/app/connectivity/docker/page";
import CloudflareSettingsPage from "@/app/connectivity/cloudflare/page";
import AzureSettingsPage from "@/app/connectivity/azure/page";
import { ConnectivityPage } from "@/app/connectivity/page";
import SystemSettingsPage from "@/app/settings/system/page";
import RegistryCredentialsPage from "@/app/settings/registry-credentials/page";
import SelfBackupSettingsPage from "@/app/settings/self-backup/page";
import PostgresPage from "@/app/postgres/page";
import PostgresRestorePage from "@/app/postgres/restore/page";
import PostgresServerPage from "@/app/postgres-server/page";
import { TunnelsPage } from "@/app/tunnels/page";
import { UserSettingsPage } from "@/app/user/settings/page";
import DeploymentsPage from "@/app/deployments/page";
import NewDeploymentConfigPage from "@/app/deployments/new/page";
import DeploymentConfigDetailsPage from "@/app/deployments/[id]/page";
import { ApiKeysPage } from "@/app/api-keys/page";
import { EnvironmentsPage } from "@/app/environments/page";
import { EnvironmentDetailPage } from "@/app/environments/[id]/page";
import { IconShowcasePage } from "@/app/design/icons/page";

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
        path: "postgres/:databaseId/restore",
        element: <PostgresRestorePage />,
      },
      {
        path: "postgres-server",
        element: <PostgresServerPage />,
      },
      {
        path: "deployments",
        element: <DeploymentsPage />,
      },
      {
        path: "deployments/new",
        element: <NewDeploymentConfigPage />,
      },
      {
        path: "deployments/:id",
        element: <DeploymentConfigDetailsPage />,
      },
      {
        path: "tunnels",
        element: <TunnelsPage />,
      },
      {
        path: "api-keys",
        element: <ApiKeysPage />,
      },
      {
        path: "environments",
        element: <EnvironmentsPage />,
      },
      {
        path: "environments/:id",
        element: <EnvironmentDetailPage />,
      },
      {
        path: "logs",
        element: <div>Activity Logs - Coming Soon</div>,
      },
      {
        path: "settings",
        element: <Navigate to="/settings/system" replace />,
      },
      {
        path: "settings/overview",
        element: <Navigate to="/settings/system" replace />,
      },
      {
        path: "connectivity",
        element: <Navigate to="/connectivity/overview" replace />,
      },
      {
        path: "connectivity/overview",
        element: <ConnectivityPage />,
      },
      {
        path: "connectivity/docker",
        element: <DockerSettingsPage />,
      },
      {
        path: "connectivity/cloudflare",
        element: <CloudflareSettingsPage />,
      },
      {
        path: "connectivity/azure",
        element: <AzureSettingsPage />,
      },
      {
        path: "settings/system",
        element: <SystemSettingsPage />,
      },
      {
        path: "settings/registry-credentials",
        element: <RegistryCredentialsPage />,
      },
      {
        path: "settings/self-backup",
        element: <SelfBackupSettingsPage />,
      },
      {
        path: "user/settings",
        element: <UserSettingsPage />,
      },
      // Development-only routes
      ...(import.meta.env.DEV
        ? [
            {
              path: "design/icons",
              element: <IconShowcasePage />,
            },
          ]
        : []),
    ],
  },
  {
    path: "*",
    element: <Navigate to="/dashboard" replace />,
  },
]);
