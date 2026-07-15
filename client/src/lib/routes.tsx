import { lazy } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { ProtectedRoute } from "@/components/protected-route";
import { PublicRoute } from "@/components/public-route";
import { AuthErrorBoundary } from "@/components/auth-error-boundary";
import { AppLayout } from "@/components/app-layout";

// Auth/entry pages stay eager: they're small and on the first-paint path for a
// logged-out user, where an extra chunk round-trip (and a spinner) is exactly
// what you don't want. Everything behind AppLayout is lazy — see below.
import { LoginPage } from "@/app/login/page";
import { SetupPage } from "@/app/setup/page";
import { PasswordRecoveryPage } from "@/app/recover/page";
import { ForcePasswordChangePage } from "@/app/change-password/page";
// Eager: takes a `fullscreen` prop and is also mounted outside AppLayout
// (`/logs/fullscreen`), so it's simplest kept out of the lazy prop-less helper.
import { LogsPage } from "@/app/logs/page";

/**
 * Route-level code splitting (P6 roadmap 5.4). Every page behind the
 * authenticated AppLayout is a `React.lazy` chunk, so the initial bundle no
 * longer carries all ~75 pages (and their heavy, page-specific deps — the
 * CodeMirror template editor, recharts, and so on) up front. A single
 * `<Suspense>` boundary around the layout's `<Outlet>` (see app-layout.tsx)
 * catches the load; the fullscreen-logs route, which lives outside the layout,
 * gets its own boundary.
 *
 * `named()` adapts our many named-export pages to what `React.lazy` wants
 * (`{ default }`); default-export pages use `lazy(() => import(...))` directly.
 */
function named<M extends Record<string, unknown>, K extends keyof M>(
  loader: () => Promise<M>,
  key: K,
) {
  return lazy(() => loader().then((m) => ({ default: m[key] as React.ComponentType })));
}

// ─── Lazy pages (all behind AppLayout) ──────────────────────────────────────
const DashboardPage = named(() => import("@/app/dashboard/page"), "DashboardPage");
const ContainersPage = named(() => import("@/app/containers/page"), "ContainersPage");
const ContainerDetailPage = lazy(() => import("@/app/containers/[id]/page"));
const VolumeInspectPage = named(
  () => import("@/app/containers/volumes/VolumeInspectPage"),
  "VolumeInspectPage",
);
const VolumeFileContentPage = named(
  () => import("@/app/containers/volumes/VolumeFileContentPage"),
  "VolumeFileContentPage",
);
const DockerSettingsPage = lazy(() => import("@/app/connectivity/docker/page"));
const CloudflareSettingsPage = lazy(() => import("@/app/connectivity/cloudflare/page"));
const StorageSettingsPage = lazy(() => import("@/app/connectivity-storage/page"));
const GitHubConnectivityPage = lazy(() => import("@/app/connectivity/github/page"));
const TailscaleSettingsPage = lazy(() => import("@/app/connectivity/tailscale/page"));
const SystemSettingsPage = lazy(() => import("@/app/settings/system/page"));
const NetworkAccessPage = lazy(() => import("@/app/network-access/page"));
const RegistryCredentialsPage = lazy(() => import("@/app/settings/registry-credentials/page"));
const SelfBackupSettingsPage = lazy(() => import("@/app/settings/self-backup/page"));
const GitHubSettingsPage = lazy(() => import("@/app/settings/github/page"));
const PostgresBackups = lazy(() => import("@/app/postgres/page"));
const PostgresRestorePage = lazy(() => import("@/app/postgres/restore/page"));
const PostgresServerPage = lazy(() => import("@/app/postgres-server/page"));
const PostgresServerDetailPage = lazy(() => import("@/app/postgres-server/[serverId]/page"));
const DatabaseDetailPage = lazy(
  () => import("@/app/postgres-server/[serverId]/databases/[dbId]/page"),
);
const TunnelsPage = named(() => import("@/app/tunnels/page"), "TunnelsPage");
const UserSettingsPage = named(() => import("@/app/user/settings/page"), "UserSettingsPage");
const ApplicationsPage = lazy(() => import("@/app/applications/page"));
const NewApplicationPage = lazy(() => import("@/app/applications/new/page"));
const NewClaudeShellPage = lazy(() => import("@/app/applications/new/claude-shell/page"));
const ApplicationDetailLayout = lazy(() => import("@/app/applications/[id]/layout"));
const ApplicationDetailIndex = lazy(() => import("@/app/applications/[id]/page"));
const ApplicationOverviewTab = lazy(() => import("@/app/applications/[id]/overview/page"));
const ApplicationServicesTab = lazy(() => import("@/app/applications/[id]/services/page"));
const ApplicationConfigurationTab = lazy(
  () => import("@/app/applications/[id]/configuration/page"),
);
const ApplicationActivityTab = lazy(() => import("@/app/applications/[id]/activity/page"));
const AdoptContainerPage = lazy(() => import("@/app/applications/adopt/page"));
const ApiKeysPage = named(() => import("@/app/api-keys/page"), "ApiKeysPage");
const CreateApiKeyPage = named(() => import("@/app/api-keys/new/page"), "CreateApiKeyPage");
const PermissionPresetsPage = named(
  () => import("@/app/api-keys/presets/page"),
  "PermissionPresetsPage",
);
const EventsPage = named(() => import("@/app/events/page"), "EventsPage");
const EventDetailPage = lazy(() => import("@/app/events/[id]/page"));
const EnvironmentsPage = named(() => import("@/app/environments/page"), "EnvironmentsPage");
const EnvironmentDetailPage = named(
  () => import("@/app/environments/[id]/page"),
  "EnvironmentDetailPage",
);
const CertificatesPage = lazy(() => import("@/app/certificates/page"));
const CertificateDetailsPage = lazy(() => import("@/app/certificates/[id]/page"));
const DnsPage = lazy(() => import("@/app/dns/page"));
const TlsSettingsPage = lazy(() => import("@/app/settings/tls/page"));
const AiAssistantSettingsPage = lazy(() => import("@/app/settings/ai-assistant/page"));
const EgressFwAgentSettingsPage = lazy(() => import("@/app/settings/egress-fw-agent/page"));
const EgressPage = lazy(() => import("@/app/egress/page"));
const EgressPolicyDetailPage = lazy(() => import("@/app/egress/[policyId]/page"));
const IconShowcasePage = named(() => import("@/app/design/icons/page"), "IconShowcasePage");
const FrontendsListPage = lazy(() => import("@/app/haproxy/frontends/page"));
const FrontendDetailsPage = lazy(() => import("@/app/haproxy/frontends/[frontendName]/page"));
const CreateManualFrontendPage = lazy(() => import("@/app/haproxy/frontends/new/manual/page"));
const EditManualFrontendPage = lazy(
  () => import("@/app/haproxy/frontends/[frontendName]/edit/page"),
);
const BackendsListPage = lazy(() => import("@/app/haproxy/backends/page"));
const BackendDetailsPage = lazy(() => import("@/app/haproxy/backends/[backendName]/page"));
const HAProxyInstancesPage = lazy(() => import("@/app/haproxy/instances/page"));
const HAProxyOverviewPage = lazy(() => import("@/app/haproxy/page"));
const SelfUpdateSettingsPage = lazy(() => import("@/app/settings/self-update/page"));
const SystemDiagnosticsPage = lazy(() => import("@/app/system-diagnostics/page"));
const MonitoringPage = named(() => import("@/app/monitoring/page"), "MonitoringPage");
const StackTemplatesPage = lazy(() => import("@/app/stack-templates/page"));
const StackTemplateDetailPage = lazy(() => import("@/app/stack-templates/[templateId]/page"));
const StacksPage = lazy(() => import("@/app/stacks/page"));
const StackDetailPage = lazy(() => import("@/app/stacks/[stackId]/page"));
const UserManagementPage = lazy(() => import("@/app/settings/users/page"));
const AuthenticationSettingsPage = lazy(() => import("@/app/settings/authentication/page"));
const VaultPage = lazy(() => import("@/app/vault/page"));
const VaultPoliciesPage = lazy(() => import("@/app/vault/policies/page"));
const VaultPolicyDetailPage = lazy(() => import("@/app/vault/policies/[id]/page"));
const VaultAppRolesPage = lazy(() => import("@/app/vault/approles/page"));
const VaultAppRoleDetailPage = lazy(() => import("@/app/vault/approles/[id]/page"));
const NatsPage = lazy(() => import("@/app/nats/page"));
const NatsAccountsPage = lazy(() => import("@/app/nats/accounts/page"));
const NatsCredentialsPage = lazy(() => import("@/app/nats/credentials/page"));
const NatsStreamsPage = lazy(() => import("@/app/nats/streams/page"));
const NatsConsumersPage = lazy(() => import("@/app/nats/consumers/page"));
const HelpPage = lazy(() => import("@/app/help/page"));
const HelpDocPage = lazy(() => import("@/app/help/[category]/[slug]/page"));

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
        path: "applications/new/claude-shell",
        element: <NewClaudeShellPage />,
      },
      {
        path: "applications/adopt",
        element: <AdoptContainerPage />,
      },
      {
        path: "applications/:id",
        element: <ApplicationDetailLayout />,
        children: [
          { index: true, element: <ApplicationDetailIndex /> },
          { path: "overview", element: <ApplicationOverviewTab /> },
          { path: "services", element: <ApplicationServicesTab /> },
          { path: "configuration", element: <ApplicationConfigurationTab /> },
          { path: "activity", element: <ApplicationActivityTab /> },
          // Legacy tab paths folded into the four above — redirect old
          // bookmarks/links so they still resolve.
          { path: "routing", element: <Navigate to="../services" replace /> },
          { path: "pool", element: <Navigate to="../services" replace /> },
          { path: "monitoring", element: <Navigate to="../activity" replace /> },
          { path: "history", element: <Navigate to="../activity" replace /> },
        ],
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
        path: "connectivity-storage",
        element: <StorageSettingsPage />,
      },
      {
        path: "connectivity-github",
        element: <GitHubConnectivityPage />,
      },
      {
        path: "connectivity-tailscale",
        element: <TailscaleSettingsPage />,
      },
      {
        path: "network-access",
        element: <NetworkAccessPage />,
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
        path: "settings-egress-fw-agent",
        element: <EgressFwAgentSettingsPage />,
      },
      {
        path: "egress",
        element: <EgressPage />,
      },
      {
        path: "egress/:policyId",
        element: <EgressPolicyDetailPage />,
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
        path: "stacks",
        element: <StacksPage />,
      },
      {
        path: "stacks/:stackId",
        element: <StackDetailPage />,
      },
      {
        path: "vault",
        element: <VaultPage />,
      },
      {
        path: "vault/policies",
        element: <VaultPoliciesPage />,
      },
      {
        path: "vault/policies/:id",
        element: <VaultPolicyDetailPage />,
      },
      {
        path: "vault/approles",
        element: <VaultAppRolesPage />,
      },
      {
        path: "vault/approles/:id",
        element: <VaultAppRoleDetailPage />,
      },
      {
        path: "nats",
        element: <NatsPage />,
      },
      {
        path: "nats/accounts",
        element: <NatsAccountsPage />,
      },
      {
        path: "nats/credentials",
        element: <NatsCredentialsPage />,
      },
      {
        path: "nats/streams",
        element: <NatsStreamsPage />,
      },
      {
        path: "nats/consumers",
        element: <NatsConsumersPage />,
      },
      {
        path: "user/settings",
        element: <UserSettingsPage />,
      },
      {
        path: "help",
        element: <HelpPage />,
      },
      {
        path: "help/:category/:slug",
        element: <HelpDocPage />,
      },
      // Development-only routes
      ...(import.meta.env.VITE_SHOW_DEV_MENU === "true"
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
