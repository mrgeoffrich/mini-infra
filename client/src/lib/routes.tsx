import React, { Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { ProtectedRoute } from "@/components/protected-route";
import { PublicRoute } from "@/components/public-route";
import { AuthErrorBoundary } from "@/components/auth-error-boundary";
import { AppLayout } from "@/components/app-layout";
import { LoginPage } from "@/app/login/page";
import { SetupPage } from "@/app/setup/page";
import { PasswordRecoveryPage } from "@/app/recover/page";
import { ForcePasswordChangePage } from "@/app/change-password/page";
import { DashboardPage } from "@/app/dashboard/page";
import { ContainersPage } from "@/app/containers/page";
import ContainerDetailPage from "@/app/containers/[id]/page";
import { VolumeInspectPage } from "@/app/containers/volumes/VolumeInspectPage";
import { VolumeFileContentPage } from "@/app/containers/volumes/VolumeFileContentPage";
import DockerSettingsPage from "@/app/connectivity/docker/page";
import CloudflareSettingsPage from "@/app/connectivity/cloudflare/page";
import AzureSettingsPage from "@/app/connectivity/azure/page";
import GitHubConnectivityPage from "@/app/connectivity/github/page";
import SystemSettingsPage from "@/app/settings/system/page";
import RegistryCredentialsPage from "@/app/settings/registry-credentials/page";
import SelfBackupSettingsPage from "@/app/settings/self-backup/page";
import GitHubSettingsPage from "@/app/settings/github/page";
import PostgresBackups from "@/app/postgres/page";
import PostgresRestorePage from "@/app/postgres/restore/page";
import PostgresServerPage from "@/app/postgres-server/page";
import PostgresServerDetailPage from "@/app/postgres-server/[serverId]/page";
import DatabaseDetailPage from "@/app/postgres-server/[serverId]/databases/[dbId]/page";
import { TunnelsPage } from "@/app/tunnels/page";
import { UserSettingsPage } from "@/app/user/settings/page";
import ApplicationsPage from "@/app/applications/page";
import NewApplicationPage from "@/app/applications/new/page";
import ApplicationDetailPage from "@/app/applications/[id]/page";
import AdoptContainerPage from "@/app/applications/adopt/page";
import { ApiKeysPage } from "@/app/api-keys/page";
import { CreateApiKeyPage } from "@/app/api-keys/new/page";
import { PermissionPresetsPage } from "@/app/api-keys/presets/page";
import { EventsPage } from "@/app/events/page";
import EventDetailPage from "@/app/events/[id]/page";
import { EnvironmentsPage } from "@/app/environments/page";
import { EnvironmentDetailPage } from "@/app/environments/[id]/page";
import CertificatesPage from "@/app/certificates/page";
import CertificateDetailsPage from "@/app/certificates/[id]/page";
import DnsPage from "@/app/dns/page";
import TlsSettingsPage from "@/app/settings/tls/page";
import AiAssistantSettingsPage from "@/app/settings/ai-assistant/page";
import { IconShowcasePage } from "@/app/design/icons/page";
import FrontendsListPage from "@/app/haproxy/frontends/page";
import FrontendDetailsPage from "@/app/haproxy/frontends/[frontendName]/page";
import CreateManualFrontendPage from "@/app/haproxy/frontends/new/manual/page";
import EditManualFrontendPage from "@/app/haproxy/frontends/[frontendName]/edit/page";
import BackendsListPage from "@/app/haproxy/backends/page";
import BackendDetailsPage from "@/app/haproxy/backends/[backendName]/page";
import HAProxyInstancesPage from "@/app/haproxy/instances/page";
import HAProxyOverviewPage from "@/app/haproxy/page";
import SelfUpdateSettingsPage from "@/app/settings/self-update/page";
import SystemDiagnosticsPage from "@/app/system-diagnostics/page";
import { MonitoringPage } from "@/app/monitoring/page";
import { LogsPage } from "@/app/logs/page";
import StackTemplatesPage from "@/app/stack-templates/page";
import StackTemplateDetailPage from "@/app/stack-templates/[templateId]/page";
import UserManagementPage from "@/app/settings/users/page";
import AuthenticationSettingsPage from "@/app/settings/authentication/page";

const HelpPage = React.lazy(() => import("@/app/help/page"));
const HelpDocPage = React.lazy(
  () => import("@/app/help/[category]/[slug]/page")
);

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
    path: "/setup",
    element: (
      <AuthErrorBoundary>
        <PublicRoute>
          <SetupPage />
        </PublicRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/recover",
    element: (
      <AuthErrorBoundary>
        <PublicRoute>
          <PasswordRecoveryPage />
        </PublicRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/change-password",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <ForcePasswordChangePage />
        </ProtectedRoute>
      </AuthErrorBoundary>
    ),
  },
  {
    path: "/logs/fullscreen",
    element: (
      <AuthErrorBoundary>
        <ProtectedRoute>
          <LogsPage fullscreen />
        </ProtectedRoute>
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
        path: "containers/:id",
        element: <ContainerDetailPage />,
      },
      {
        path: "containers/volumes/:name/inspect",
        element: <VolumeInspectPage />,
      },
      {
        path: "containers/volumes/:name/files/*",
        element: <VolumeFileContentPage />,
      },
      {
        path: "postgres-backup",
        element: <PostgresBackups />,
      },
      {
        path: "postgres-backup/:databaseId/restore",
        element: <PostgresRestorePage />,
      },
      {
        path: "postgres-server",
        element: <PostgresServerPage />,
      },
      {
        path: "postgres-server/:serverId",
        element: <PostgresServerDetailPage />,
      },
      {
        path: "postgres-server/:serverId/databases/:dbId",
        element: <DatabaseDetailPage />,
      },
      {
        path: "applications",
        element: <ApplicationsPage />,
      },
      {
        path: "applications/new",
        element: <NewApplicationPage />,
      },
      {
        path: "applications/adopt",
        element: <AdoptContainerPage />,
      },
      {
        path: "applications/:id",
        element: <ApplicationDetailPage />,
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
        path: "api-keys/new",
        element: <CreateApiKeyPage />,
      },
      {
        path: "api-keys/presets",
        element: <PermissionPresetsPage />,
      },
      {
        path: "events",
        element: <EventsPage />,
      },
      {
        path: "events/:id",
        element: <EventDetailPage />,
      },
      {
        path: "certificates",
        element: <CertificatesPage />,
      },
      {
        path: "certificates/:id",
        element: <CertificateDetailsPage />,
      },
      {
        path: "dns",
        element: <DnsPage />,
      },
      {
        path: "haproxy",
        element: <HAProxyOverviewPage />,
      },
      {
        path: "haproxy/frontends",
        element: <FrontendsListPage />,
      },
      {
        path: "haproxy/frontends/new/manual",
        element: <CreateManualFrontendPage />,
      },
      {
        path: "haproxy/frontends/:frontendName",
        element: <FrontendDetailsPage />,
      },
      {
        path: "haproxy/frontends/:frontendName/edit",
        element: <EditManualFrontendPage />,
      },
      {
        path: "haproxy/backends",
        element: <BackendsListPage />,
      },
      {
        path: "haproxy/backends/:backendName",
        element: <BackendDetailsPage />,
      },
      {
        path: "haproxy/instances",
        element: <HAProxyInstancesPage />,
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
        path: "monitoring",
        element: <MonitoringPage />,
      },
      {
        path: "logs",
        element: <LogsPage />,
      },
      {
        path: "connectivity-docker",
        element: <DockerSettingsPage />,
      },
      {
        path: "connectivity-cloudflare",
        element: <CloudflareSettingsPage />,
      },
      {
        path: "connectivity-azure",
        element: <AzureSettingsPage />,
      },
      {
        path: "connectivity-github",
        element: <GitHubConnectivityPage />,
      },
      {
        path: "settings-system",
        element: <SystemSettingsPage />,
      },
      {
        path: "settings-registry-credentials",
        element: <RegistryCredentialsPage />,
      },
      {
        path: "settings-self-backup",
        element: <SelfBackupSettingsPage />,
      },
      {
        path: "settings-tls",
        element: <TlsSettingsPage />,
      },
      {
        path: "settings-ai-assistant",
        element: <AiAssistantSettingsPage />,
      },
      {
        path: "settings-self-update",
        element: <SelfUpdateSettingsPage />,
      },
      {
        path: "system-diagnostics",
        element: <SystemDiagnosticsPage />,
      },
      {
        path: "settings-users",
        element: <UserManagementPage />,
      },
      {
        path: "settings-authentication",
        element: <AuthenticationSettingsPage />,
      },
      {
        path: "bug-report-settings",
        element: <GitHubSettingsPage />,
      },
      {
        path: "stack-templates",
        element: <StackTemplatesPage />,
      },
      {
        path: "stack-templates/:templateId",
        element: <StackTemplateDetailPage />,
      },
      {
        path: "user/settings",
        element: <UserSettingsPage />,
      },
      {
        path: "help",
        element: (
          <Suspense>
            <HelpPage />
          </Suspense>
        ),
      },
      {
        path: "help/:category/:slug",
        element: (
          <Suspense>
            <HelpDocPage />
          </Suspense>
        ),
      },
      // Development-only routes
      ...(import.meta.env.VITE_SHOW_DEV_MENU === 'true'
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
