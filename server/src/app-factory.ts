import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
  Router,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import expressListEndpoints from "express-list-endpoints";
import path from "path";
import { randomUUID } from "crypto";
import appConfig from "./lib/config-new";
import { createDynamicCorsOrigin, isForceInsecureOverride } from "./lib/public-url-service";
import { buildPinoHttpOptions } from "./lib/logger-factory";
import {
  requestContextMiddleware,
  type RequestWithId,
} from "./middleware/request-context";
import { createHelmetDispatcher } from "./lib/security";
import { errorHandler, notFoundHandler } from "./lib/error-handler";
import { extractJwtUser } from "./lib/jwt-middleware";
import authRoutes from "./routes/auth";
import apiKeyRoutes from "./routes/api-keys";
import containerRoutes from "./routes/containers";
import dockerRoutes from "./routes/docker";
import settingsRoutes from "./routes/settings";
import settingsConnectivityRoutes from "./routes/settings-connectivity";
import settingsValidationRoutes from "./routes/settings-validation";
import settingsDockerRoutes from "./routes/settings-docker";
import storageSettingsRoutes from "./routes/storage-settings";
import storageConnectivityRoutes from "./routes/storage-connectivity";
import storageGoogleDriveOAuthRoutes from "./routes/storage-google-drive-oauth";
import cloudflareSettingsRoutes from "./routes/cloudflare-settings";
import cloudflareConnectivityRoutes from "./routes/cloudflare-connectivity";
import tailscaleSettingsRoutes from "./routes/tailscale-settings";
import tailscaleConnectivityRoutes from "./routes/tailscale-connectivity";
import tailscaleDevicesRoutes from "./routes/tailscale-devices";
import githubSettingsRoutes from "./routes/github-settings";
import githubBugReportRoutes from "./routes/github-bug-report";
import postgresDatabasesRoutes from "./routes/postgres-databases";
import postgresBackupConfigsRoutes from "./routes/postgres-backup-configs";
import postgresBackupsRoutes from "./routes/postgres-backups";
import postgresRestoreRoutes from "./routes/postgres-restore";
import postgresProgressRoutes from "./routes/postgres-progress";
import userPreferencesRoutes from "./routes/user-preferences";
import systemSettingsRoutes from "./routes/system-settings";
import environmentsRoutes from "./routes/environments";
import haproxyFrontendsRoutes from "./routes/haproxy-frontends";
import manualHaproxyFrontendsRoutes from "./routes/manual-haproxy-frontends";
import selfBackupSettingsRoutes from "./routes/settings-self-backup";
import selfBackupsRoutes from "./routes/self-backups";
import createRegistryCredentialsRouter from "./routes/registry-credentials";
import postgresServerRoutes from "./routes/postgres-server/servers";
import postgresServerGrantsRoutes from "./routes/postgres-server/grants";
import postgresServerWorkflowsRoutes from "./routes/postgres-server/workflows";
import tlsCertificatesRoutes from "./routes/tls-certificates";
import tlsRenewalsRoutes from "./routes/tls-renewals";
import tlsSettingsRoutes from "./routes/tls-settings";
import eventsRoutes from "./routes/events";
import haproxyBackendsRoutes from "./routes/haproxy-backends";
import githubAppSettingsRoutes from "./routes/github-app-settings";
import githubAppResourcesRoutes from "./routes/github-app-resources";
import agentRoutes from "./routes/agent";
import monitoringRoutes from "./routes/monitoring";
import permissionPresetsRoutes from "./routes/permission-presets";
import stacksRoutes from "./routes/stacks/index";
import stackTemplatesRoutes from "./routes/stack-templates";
import selfUpdateRoutes from "./routes/self-update";
import agentSidecarRoutes from "./routes/agent-sidecar";
import dnsRoutes from "./routes/dns";
import createImagesRouter from "./routes/images";
import apiRoutesRoutes from "./routes/api-routes";
import usersRoutes from "./routes/users";
import authSettingsRoutes from "./routes/auth-settings";
import diagnosticsRoutes from "./routes/diagnostics";
import onboardingRoutes from "./routes/onboarding";
import openapiRoutes from "./routes/openapi";
import devApiKeyRoutes from "./routes/dev-api-key";
import vaultRoutes from "./routes/vault";
import vaultPolicyRoutes from "./routes/vault/policies";
import vaultAppRoleRoutes from "./routes/vault/approles";
import vaultKvRoutes from "./routes/vault/kv";
import natsRoutes from "./routes/nats";
import natsPrefixAllowlistRoutes from "./routes/nats-prefix-allowlist";
import egressRoutes from "./routes/egress";
import egressFwAgentRoutes from "./routes/egress-fw-agent";
import { listRouteMeta } from "./lib/openapi-registry";
import { ApiBase } from "@mini-infra/types";

type RouteDefinition = {
  id: string;
  path: string;
  name: string;
  getRouter: () => Router | undefined;
};

export type CreateAppOptions = {
  includeRouteIds?: string[];
  routeOverrides?: Record<string, Router | undefined>;
  quiet?: boolean;
};

// Path prefixes that have been migrated to describeRoute(). Expand as more routes adopt it.
// A warning fires in development for any route under these prefixes that lacks registry metadata.
const MIGRATED_ROUTE_PREFIXES = ["/api/diagnostics"];

function warnOnRouteMetadataDrift(app: express.Application): void {
  try {
    const endpoints = expressListEndpoints(app);
    const registryKeys = new Set(
      listRouteMeta().map((m) => `${m.method.toUpperCase()} ${m.path}`),
    );
    const missing: string[] = [];
    for (const endpoint of endpoints) {
      if (!MIGRATED_ROUTE_PREFIXES.some((p) => endpoint.path.startsWith(p))) {
        continue;
      }
      for (const method of endpoint.methods) {
        const key = `${method} ${endpoint.path}`;
        if (!registryKeys.has(key)) {
          missing.push(key);
        }
      }
    }
    if (missing.length > 0) {
      console.warn(
        `⚠ describeRoute drift: ${missing.length} route(s) under migrated prefixes missing OpenAPI metadata:\n  ` +
          missing.join("\n  "),
      );
    }
  } catch (err) {
    console.warn("Route metadata drift check failed:", err);
  }
}

function getRouteDefinitions(): RouteDefinition[] {
  return [
    { id: "auth", path: ApiBase.auth, name: "authRoutes", getRouter: () => authRoutes },
    { id: "users", path: ApiBase.users, name: "usersRoutes", getRouter: () => usersRoutes },
    { id: "authSettings", path: ApiBase.authSettings, name: "authSettingsRoutes", getRouter: () => authSettingsRoutes },
    { id: "apiKeys", path: ApiBase.apiKeys, name: "apiKeyRoutes", getRouter: () => apiKeyRoutes },
    { id: "containers", path: ApiBase.containers, name: "containerRoutes", getRouter: () => containerRoutes },
    { id: "docker", path: ApiBase.docker, name: "dockerRoutes", getRouter: () => dockerRoutes },
    { id: "selfBackupSettings", path: ApiBase.selfBackupSettings, name: "selfBackupSettingsRoutes", getRouter: () => selfBackupSettingsRoutes },
    { id: "systemSettings", path: ApiBase.systemSettings, name: "systemSettingsRoutes", getRouter: () => systemSettingsRoutes },
    { id: "storageGoogleDriveOAuth", path: ApiBase.storageGoogleDriveOAuth, name: "storageGoogleDriveOAuthRoutes", getRouter: () => storageGoogleDriveOAuthRoutes },
    { id: "storageSettings", path: ApiBase.storageSettings, name: "storageSettingsRoutes", getRouter: () => storageSettingsRoutes },
    { id: "cloudflareSettings", path: ApiBase.cloudflareSettings, name: "cloudflareSettingsRoutes", getRouter: () => cloudflareSettingsRoutes },
    { id: "tailscaleSettings", path: ApiBase.tailscaleSettings, name: "tailscaleSettingsRoutes", getRouter: () => tailscaleSettingsRoutes },
    { id: "githubSettings", path: ApiBase.githubSettings, name: "githubSettingsRoutes", getRouter: () => githubSettingsRoutes },
    { id: "githubAppSettings", path: ApiBase.githubAppSettings, name: "githubAppSettingsRoutes", getRouter: () => githubAppSettingsRoutes },
    { id: "githubAppResources", path: ApiBase.githubAppResources, name: "githubAppResourcesRoutes", getRouter: () => githubAppResourcesRoutes },
    { id: "githubBugReport", path: ApiBase.githubBugReport, name: "githubBugReportRoutes", getRouter: () => githubBugReportRoutes },
    { id: "settingsConnectivity", path: ApiBase.settingsConnectivity, name: "settingsConnectivityRoutes", getRouter: () => settingsConnectivityRoutes },
    { id: "settingsValidation", path: ApiBase.settingsValidation, name: "settingsValidationRoutes", getRouter: () => settingsValidationRoutes },
    { id: "settingsDocker", path: ApiBase.settingsDocker, name: "settingsDockerRoutes", getRouter: () => settingsDockerRoutes },
    { id: "settings", path: ApiBase.settings, name: "settingsRoutes", getRouter: () => settingsRoutes },
    { id: "storageConnectivity", path: ApiBase.storageConnectivity, name: "storageConnectivityRoutes", getRouter: () => storageConnectivityRoutes },
    { id: "cloudflareConnectivity", path: ApiBase.cloudflareConnectivity, name: "cloudflareConnectivityRoutes", getRouter: () => cloudflareConnectivityRoutes },
    { id: "tailscaleConnectivity", path: ApiBase.tailscaleConnectivity, name: "tailscaleConnectivityRoutes", getRouter: () => tailscaleConnectivityRoutes },
    { id: "tailscaleDevices", path: ApiBase.tailscaleDevices, name: "tailscaleDevicesRoutes", getRouter: () => tailscaleDevicesRoutes },
    { id: "postgresDatabases", path: ApiBase.postgresDatabases, name: "postgresDatabasesRoutes", getRouter: () => postgresDatabasesRoutes },
    { id: "postgresBackupConfigs", path: ApiBase.postgresBackupConfigs, name: "postgresBackupConfigsRoutes", getRouter: () => postgresBackupConfigsRoutes },
    { id: "postgresBackups", path: ApiBase.postgresBackups, name: "postgresBackupsRoutes", getRouter: () => postgresBackupsRoutes },
    { id: "postgresRestore", path: ApiBase.postgresRestore, name: "postgresRestoreRoutes", getRouter: () => postgresRestoreRoutes },
    { id: "postgresProgress", path: ApiBase.postgresProgress, name: "postgresProgressRoutes", getRouter: () => postgresProgressRoutes },
    { id: "userPreferences", path: ApiBase.userPreferences, name: "userPreferencesRoutes", getRouter: () => userPreferencesRoutes },
    { id: "haproxyFrontends", path: ApiBase.haproxyFrontends, name: "haproxyFrontendsRoutes", getRouter: () => haproxyFrontendsRoutes },
    { id: "manualHaproxyFrontends", path: ApiBase.manualHaproxyFrontends, name: "manualHaproxyFrontendsRoutes", getRouter: () => manualHaproxyFrontendsRoutes },
    { id: "haproxyBackends", path: ApiBase.haproxyBackends, name: "haproxyBackendsRoutes", getRouter: () => haproxyBackendsRoutes },
    { id: "environments", path: ApiBase.environments, name: "environmentsRoutes", getRouter: () => environmentsRoutes },
    { id: "selfBackups", path: ApiBase.selfBackups, name: "selfBackupsRoutes", getRouter: () => selfBackupsRoutes },
    { id: "registryCredentials", path: ApiBase.registryCredentials, name: "registryCredentialsRoutes", getRouter: createRegistryCredentialsRouter },
    { id: "postgresServer", path: ApiBase.postgresServer, name: "postgresServerRoutes", getRouter: () => postgresServerRoutes },
    { id: "postgresServerGrants", path: ApiBase.postgresServerGrants, name: "postgresServerGrantsRoutes", getRouter: () => postgresServerGrantsRoutes },
    { id: "postgresServerWorkflows", path: ApiBase.postgresServerWorkflows, name: "postgresServerWorkflowsRoutes", getRouter: () => postgresServerWorkflowsRoutes },
    { id: "tlsSettings", path: ApiBase.tlsSettings, name: "tlsSettingsRoutes", getRouter: () => tlsSettingsRoutes },
    { id: "tlsCertificates", path: ApiBase.tlsCertificates, name: "tlsCertificatesRoutes", getRouter: () => tlsCertificatesRoutes },
    { id: "tlsRenewals", path: ApiBase.tlsRenewals, name: "tlsRenewalsRoutes", getRouter: () => tlsRenewalsRoutes },
    { id: "events", path: ApiBase.events, name: "eventsRoutes", getRouter: () => eventsRoutes },
    { id: "monitoring", path: ApiBase.monitoring, name: "monitoringRoutes", getRouter: () => monitoringRoutes },
    { id: "permissionPresets", path: ApiBase.permissionPresets, name: "permissionPresetsRoutes", getRouter: () => permissionPresetsRoutes },
    { id: "egress", path: ApiBase.egress, name: "egressRoutes", getRouter: () => egressRoutes },
    { id: "egressFwAgent", path: ApiBase.egressFwAgent, name: "egressFwAgentRoutes", getRouter: () => egressFwAgentRoutes },
    { id: "stacks", path: ApiBase.stacks, name: "stacksRoutes", getRouter: () => stacksRoutes },
    { id: "stackTemplates", path: ApiBase.stackTemplates, name: "stackTemplatesRoutes", getRouter: () => stackTemplatesRoutes },
    { id: "selfUpdate", path: ApiBase.selfUpdate, name: "selfUpdateRoutes", getRouter: () => selfUpdateRoutes },
    { id: "agentSidecar", path: ApiBase.agentSidecar, name: "agentSidecarRoutes", getRouter: () => agentSidecarRoutes },
    { id: "dns", path: ApiBase.dns, name: "dnsRoutes", getRouter: () => dnsRoutes },
    { id: "images", path: ApiBase.images, name: "imagesRoutes", getRouter: createImagesRouter },
    { id: "apiRoutes", path: ApiBase.apiRoutes, name: "apiRoutesRoutes", getRouter: () => apiRoutesRoutes },
    { id: "openapi", path: ApiBase.openapi, name: "openapiRoutes", getRouter: () => openapiRoutes },
    { id: "agent", path: ApiBase.agent, name: "agentRoutes", getRouter: () => agentRoutes },
    { id: "diagnostics", path: ApiBase.diagnostics, name: "diagnosticsRoutes", getRouter: () => diagnosticsRoutes },
    { id: "onboarding", path: ApiBase.onboarding, name: "onboardingRoutes", getRouter: () => onboardingRoutes },
    { id: "vaultPolicies", path: ApiBase.vaultPolicies, name: "vaultPolicyRoutes", getRouter: () => vaultPolicyRoutes },
    { id: "vaultAppRoles", path: ApiBase.vaultAppRoles, name: "vaultAppRoleRoutes", getRouter: () => vaultAppRoleRoutes },
    // KV broker — must be mounted BEFORE the catch-all `/api/vault` router
    // so requests to `/api/vault/kv/...` reach this router instead of the
    // shared status/bootstrap router.
    { id: "vaultKv", path: ApiBase.vaultKv, name: "vaultKvRoutes", getRouter: () => vaultKvRoutes },
    { id: "vault", path: ApiBase.vault, name: "vaultRoutes", getRouter: () => vaultRoutes },
    // Allowlist must be mounted BEFORE the catch-all `/api/nats` router so
    // requests to `/api/nats/prefix-allowlist/...` reach this router instead.
    { id: "natsPrefixAllowlist", path: ApiBase.natsPrefixAllowlist, name: "natsPrefixAllowlistRoutes", getRouter: () => natsPrefixAllowlistRoutes },
    { id: "nats", path: ApiBase.nats, name: "natsRoutes", getRouter: () => natsRoutes },
    // Dev-only: exchange admin credentials for a full-admin API key. Only
    // registered when ENABLE_DEV_API_KEY_ENDPOINT=true — otherwise getRouter
    // returns undefined and the route is skipped.
    {
      id: "devApiKey",
      path: ApiBase.devApiKey,
      name: "devApiKeyRoutes",
      getRouter: () =>
        process.env.ENABLE_DEV_API_KEY_ENDPOINT === "true"
          ? devApiKeyRoutes
          : undefined,
    },
  ];
}

export function createApp(options: CreateAppOptions = {}): express.Application {
  const app: express.Application = express();
  const routeDefinitions = getRouteDefinitions();
  const includeRouteIds = new Set(
    options.includeRouteIds ?? routeDefinitions.map((route) => route.id),
  );
  const shouldLogRoutes = !options.quiet && appConfig.server.nodeEnv !== "test";

  app.set("trust proxy", true);
  app.use(requestContextMiddleware as RequestHandler);

  app.use(
    pinoHttp({
      // Pass pino options instead of a pre-built logger. pino-http bundles
      // its own nested pino copy, so a logger built with the server's pino
      // has mismatched internal Symbols (stringifySym etc.) and crashes
      // pino-http on res.finish. Letting pino-http construct its own
      // logger from these options keeps component/subcomponent/mixin/
      // redaction consistent while avoiding the dupe-dependency crash.
      ...buildPinoHttpOptions("http", "access"),
      // Reuse the id set by requestContextMiddleware so access-log lines
      // carry the same requestId as application-code log lines, even
      // though pino-http emits on res.finish (potentially outside the
      // original ALS scope). The mixin from buildPinoHttpOptions already
      // injects requestId from ALS when it's still alive; customProps.userId
      // is a belt-and-braces fallback because userId is set mid-request by
      // jwt-middleware and should land on every access log line that has
      // an authenticated user.
      genReqId: (req) =>
        (req as RequestWithId).requestId ?? randomUUID(),
      customProps: (req) => ({
        userId: (req as Request).user?.id,
      }),
      customLogLevel: (_req, res) => {
        if (res.statusCode >= 400) return "warn";
        if (res.statusCode >= 300) return "info";
        return "info";
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          headers: req.headers,
          remoteAddress: req.remoteAddress,
          remotePort: req.remotePort,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
          headers: res.headers,
        }),
      },
      customAttributeKeys: {
        req: "req",
        res: "res",
        err: "err",
        responseTime: "responseTime",
      },
      autoLogging: {
        ignore: () => false,
      },
      customErrorMessage: () => "",
      customErrorObject: () => ({}),
    }),
  );

  app.use(createHelmetDispatcher());
  app.use(
    cors({
      origin: createDynamicCorsOrigin(appConfig.server.nodeEnv),
      credentials: true,
      optionsSuccessStatus: 200,
    }),
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use(cookieParser());
  app.use(extractJwtUser as RequestHandler);

  app.get("/health", ((req: Request, res: Response) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      environment: appConfig.server.nodeEnv,
      uptime: process.uptime(),
      version: process.env.BUILD_VERSION || "dev",
      forceInsecureOverride: isForceInsecureOverride(),
    });
  }) as RequestHandler);

  for (const route of routeDefinitions) {
    if (!includeRouteIds.has(route.id)) {
      continue;
    }

    const router = options.routeOverrides?.[route.id] ?? route.getRouter();
    if (!router) {
      continue;
    }

    try {
      if (shouldLogRoutes) {
        console.log(`Registering route: ${route.name} at path: ${route.path}`);
      }
      app.use(route.path, router);
      if (shouldLogRoutes) {
        console.log(`✓ Successfully registered: ${route.name}`);
      }
    } catch (error) {
      console.error(`✗ Failed to register route: ${route.name} at path: ${route.path}`);
      console.error("Error:", error);
      throw error;
    }
  }

  if (appConfig.server.nodeEnv === "development" && !options.quiet) {
    warnOnRouteMetadataDrift(app);
  }

  if (appConfig.server.nodeEnv === "production") {
    const publicPath = path.join(process.cwd(), "public");
    app.use(
      express.static(publicPath, {
        dotfiles: "ignore",
      }),
    );

    const indexPath = path.join(publicPath, "index.html");
    app.get("/*path", ((req: Request, res: Response, next: NextFunction) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/auth") ||
        req.path.startsWith("/health") ||
        req.path.startsWith("/assets")
      ) {
        return next();
      }

      res.sendFile(indexPath);
    }) as RequestHandler);
  }

  if (appConfig.server.nodeEnv === "development") {
    app.get("/", ((req: Request, res: Response) => {
      res.json({
        message: "Mini Infra API Server",
        environment: appConfig.server.nodeEnv,
        timestamp: new Date().toISOString(),
        docs: "/health for health check",
      });
    }) as RequestHandler);
  }

  app.use(notFoundHandler as RequestHandler);
  app.use(errorHandler);

  return app;
}
