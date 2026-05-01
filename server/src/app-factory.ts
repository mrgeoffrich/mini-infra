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
import appConfig, { securityConfig } from "./lib/config-new";
import { createDynamicCorsOrigin } from "./lib/public-url-service";
import { buildPinoHttpOptions } from "./lib/logger-factory";
import {
  requestContextMiddleware,
  type RequestWithId,
} from "./middleware/request-context";
import { createHelmetMiddleware } from "./lib/security";
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
import egressRoutes from "./routes/egress";
import egressFwAgentRoutes from "./routes/egress-fw-agent";
import { listRouteMeta } from "./lib/openapi-registry";

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
    { id: "auth", path: "/auth", name: "authRoutes", getRouter: () => authRoutes },
    { id: "users", path: "/api/users", name: "usersRoutes", getRouter: () => usersRoutes },
    { id: "authSettings", path: "/api/auth-settings", name: "authSettingsRoutes", getRouter: () => authSettingsRoutes },
    { id: "apiKeys", path: "/api/keys", name: "apiKeyRoutes", getRouter: () => apiKeyRoutes },
    { id: "containers", path: "/api/containers", name: "containerRoutes", getRouter: () => containerRoutes },
    { id: "docker", path: "/api/docker", name: "dockerRoutes", getRouter: () => dockerRoutes },
    { id: "selfBackupSettings", path: "/api/settings/self-backup", name: "selfBackupSettingsRoutes", getRouter: () => selfBackupSettingsRoutes },
    { id: "systemSettings", path: "/api/settings/system", name: "systemSettingsRoutes", getRouter: () => systemSettingsRoutes },
    { id: "storageGoogleDriveOAuth", path: "/api/storage/google-drive/oauth", name: "storageGoogleDriveOAuthRoutes", getRouter: () => storageGoogleDriveOAuthRoutes },
    { id: "storageSettings", path: "/api/storage", name: "storageSettingsRoutes", getRouter: () => storageSettingsRoutes },
    { id: "cloudflareSettings", path: "/api/settings/cloudflare", name: "cloudflareSettingsRoutes", getRouter: () => cloudflareSettingsRoutes },
    { id: "githubSettings", path: "/api/settings/github", name: "githubSettingsRoutes", getRouter: () => githubSettingsRoutes },
    { id: "githubAppSettings", path: "/api/settings/github-app", name: "githubAppSettingsRoutes", getRouter: () => githubAppSettingsRoutes },
    { id: "githubAppResources", path: "/api/github-app", name: "githubAppResourcesRoutes", getRouter: () => githubAppResourcesRoutes },
    { id: "githubBugReport", path: "/api/github/bug-report", name: "githubBugReportRoutes", getRouter: () => githubBugReportRoutes },
    { id: "settingsConnectivity", path: "/api/settings/connectivity", name: "settingsConnectivityRoutes", getRouter: () => settingsConnectivityRoutes },
    { id: "settingsValidation", path: "/api/settings/validate", name: "settingsValidationRoutes", getRouter: () => settingsValidationRoutes },
    { id: "settingsDocker", path: "/api/settings/docker-host", name: "settingsDockerRoutes", getRouter: () => settingsDockerRoutes },
    { id: "settings", path: "/api/settings", name: "settingsRoutes", getRouter: () => settingsRoutes },
    { id: "storageConnectivity", path: "/api/connectivity/storage", name: "storageConnectivityRoutes", getRouter: () => storageConnectivityRoutes },
    { id: "cloudflareConnectivity", path: "/api/connectivity", name: "cloudflareConnectivityRoutes", getRouter: () => cloudflareConnectivityRoutes },
    { id: "postgresDatabases", path: "/api/postgres/databases", name: "postgresDatabasesRoutes", getRouter: () => postgresDatabasesRoutes },
    { id: "postgresBackupConfigs", path: "/api/postgres/backup-configs", name: "postgresBackupConfigsRoutes", getRouter: () => postgresBackupConfigsRoutes },
    { id: "postgresBackups", path: "/api/postgres", name: "postgresBackupsRoutes", getRouter: () => postgresBackupsRoutes },
    { id: "postgresRestore", path: "/api/postgres", name: "postgresRestoreRoutes", getRouter: () => postgresRestoreRoutes },
    { id: "postgresProgress", path: "/api/postgres/progress", name: "postgresProgressRoutes", getRouter: () => postgresProgressRoutes },
    { id: "userPreferences", path: "/api/user", name: "userPreferencesRoutes", getRouter: () => userPreferencesRoutes },
    { id: "haproxyFrontends", path: "/api/haproxy/frontends", name: "haproxyFrontendsRoutes", getRouter: () => haproxyFrontendsRoutes },
    { id: "manualHaproxyFrontends", path: "/api/haproxy/manual-frontends", name: "manualHaproxyFrontendsRoutes", getRouter: () => manualHaproxyFrontendsRoutes },
    { id: "haproxyBackends", path: "/api/haproxy/backends", name: "haproxyBackendsRoutes", getRouter: () => haproxyBackendsRoutes },
    { id: "environments", path: "/api/environments", name: "environmentsRoutes", getRouter: () => environmentsRoutes },
    { id: "selfBackups", path: "/api/self-backups", name: "selfBackupsRoutes", getRouter: () => selfBackupsRoutes },
    { id: "registryCredentials", path: "/api/registry-credentials", name: "registryCredentialsRoutes", getRouter: createRegistryCredentialsRouter },
    { id: "postgresServer", path: "/api/postgres-server/servers", name: "postgresServerRoutes", getRouter: () => postgresServerRoutes },
    { id: "postgresServerGrants", path: "/api/postgres-server/grants", name: "postgresServerGrantsRoutes", getRouter: () => postgresServerGrantsRoutes },
    { id: "postgresServerWorkflows", path: "/api/postgres-server/workflows", name: "postgresServerWorkflowsRoutes", getRouter: () => postgresServerWorkflowsRoutes },
    { id: "tlsSettings", path: "/api/tls", name: "tlsSettingsRoutes", getRouter: () => tlsSettingsRoutes },
    { id: "tlsCertificates", path: "/api/tls/certificates", name: "tlsCertificatesRoutes", getRouter: () => tlsCertificatesRoutes },
    { id: "tlsRenewals", path: "/api/tls/renewals", name: "tlsRenewalsRoutes", getRouter: () => tlsRenewalsRoutes },
    { id: "events", path: "/api/events", name: "eventsRoutes", getRouter: () => eventsRoutes },
    { id: "monitoring", path: "/api/monitoring", name: "monitoringRoutes", getRouter: () => monitoringRoutes },
    { id: "permissionPresets", path: "/api/permission-presets", name: "permissionPresetsRoutes", getRouter: () => permissionPresetsRoutes },
    { id: "egress", path: "/api/egress", name: "egressRoutes", getRouter: () => egressRoutes },
    { id: "egressFwAgent", path: "/api/egress-fw-agent", name: "egressFwAgentRoutes", getRouter: () => egressFwAgentRoutes },
    { id: "stacks", path: "/api/stacks", name: "stacksRoutes", getRouter: () => stacksRoutes },
    { id: "stackTemplates", path: "/api/stack-templates", name: "stackTemplatesRoutes", getRouter: () => stackTemplatesRoutes },
    { id: "selfUpdate", path: "/api/self-update", name: "selfUpdateRoutes", getRouter: () => selfUpdateRoutes },
    { id: "agentSidecar", path: "/api/agent-sidecar", name: "agentSidecarRoutes", getRouter: () => agentSidecarRoutes },
    { id: "dns", path: "/api/dns", name: "dnsRoutes", getRouter: () => dnsRoutes },
    { id: "images", path: "/api/images", name: "imagesRoutes", getRouter: createImagesRouter },
    { id: "apiRoutes", path: "/api/routes", name: "apiRoutesRoutes", getRouter: () => apiRoutesRoutes },
    { id: "openapi", path: "/api/openapi.json", name: "openapiRoutes", getRouter: () => openapiRoutes },
    { id: "agent", path: "/api/agent", name: "agentRoutes", getRouter: () => agentRoutes },
    { id: "diagnostics", path: "/api/diagnostics", name: "diagnosticsRoutes", getRouter: () => diagnosticsRoutes },
    { id: "onboarding", path: "/api/onboarding", name: "onboardingRoutes", getRouter: () => onboardingRoutes },
    { id: "vaultPolicies", path: "/api/vault/policies", name: "vaultPolicyRoutes", getRouter: () => vaultPolicyRoutes },
    { id: "vaultAppRoles", path: "/api/vault/approles", name: "vaultAppRoleRoutes", getRouter: () => vaultAppRoleRoutes },
    // KV broker — must be mounted BEFORE the catch-all `/api/vault` router
    // so requests to `/api/vault/kv/...` reach this router instead of the
    // shared status/bootstrap router.
    { id: "vaultKv", path: "/api/vault/kv", name: "vaultKvRoutes", getRouter: () => vaultKvRoutes },
    { id: "vault", path: "/api/vault", name: "vaultRoutes", getRouter: () => vaultRoutes },
    // Dev-only: exchange admin credentials for a full-admin API key. Only
    // registered when ENABLE_DEV_API_KEY_ENDPOINT=true — otherwise getRouter
    // returns undefined and the route is skipped.
    {
      id: "devApiKey",
      path: "/api/dev",
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

  app.use(createHelmetMiddleware(securityConfig.allowInsecure));
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
