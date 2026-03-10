import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "path";

// Import configuration and utilities
import appConfig, { securityConfig, corsOrigin } from "./lib/config-new";
import { httpLogger } from "./lib/logger-factory";
import { requestIdMiddleware } from "./lib/request-id";
import { createHelmetMiddleware } from "./lib/security";
import { errorHandler, notFoundHandler } from "./lib/error-handler";

// __filename and __dirname are available globally in CommonJS

const app: express.Application = express();

// Trust proxy if behind reverse proxy (for rate limiting and IP detection)
app.set("trust proxy", true);

// Request correlation ID middleware (must be first)
app.use(requestIdMiddleware as RequestHandler);

// Pino HTTP logging middleware
app.use(
  pinoHttp({
    logger: httpLogger(),
    customLogLevel: (req, res) => {
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
    // Disable automatic error logging by pino-http to prevent duplicate/wrong stack traces
    customAttributeKeys: {
      req: 'req',
      res: 'res',
      err: 'err',
      responseTime: 'responseTime'
    },
    // Only log HTTP request/response info, not errors - let our error handler do that
    autoLogging: {
      ignore: (req) => false,
    },
    // Prevent pino-http from logging errors with its own stack trace
    customErrorMessage: () => '', // Empty string disables error logging
    // Don't log error details in HTTP logger - our error handler will do it
    customErrorObject: () => ({})
  }),
);

// Security middleware - conditionally disable HTTPS enforcement based on ALLOW_INSECURE
app.use(createHelmetMiddleware(securityConfig.allowInsecure));

// CORS configuration
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Cookie parsing middleware for JWT tokens
app.use(cookieParser());

// Import JWT middleware
import { extractJwtUser } from "./lib/jwt-middleware";

// JWT user extraction middleware
app.use(extractJwtUser as RequestHandler);

app.get("/health", ((req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: appConfig.server.nodeEnv,
    uptime: process.uptime(),
  });
}) as RequestHandler);

// Import routes
import authRoutes from "./routes/auth";
import apiKeyRoutes from "./routes/api-keys";
import containerRoutes from "./routes/containers";
import dockerRoutes from "./routes/docker";
import settingsRoutes from "./routes/settings";
import settingsConnectivityRoutes from "./routes/settings-connectivity";
import settingsValidationRoutes from "./routes/settings-validation";
import settingsSecurityRoutes from "./routes/settings-security";
import settingsDockerRoutes from "./routes/settings-docker";
import azureSettingsRoutes from "./routes/azure-settings";
import azureConnectivityRoutes from "./routes/azure-connectivity";
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
import deploymentInfrastructureRoutes from "./routes/deployment-infrastructure";
import deploymentsRoutes from "./routes/deployments";
import environmentsRoutes from "./routes/environments";
import deploymentDnsRoutes from "./routes/deployment-dns";
import haproxyFrontendsRoutes from "./routes/haproxy-frontends";
import manualHaproxyFrontendsRoutes from "./routes/manual-haproxy-frontends";
import selfBackupSettingsRoutes from "./routes/settings-self-backup";
import selfBackupsRoutes from "./routes/self-backups";
import registryCredentialsRoutes from "./routes/registry-credentials";
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
import stacksRoutes from "./routes/stacks";
import stackTemplatesRoutes from "./routes/stack-templates";
import selfUpdateRoutes from "./routes/self-update";

// JWT-based authentication doesn't require CSRF protection for now
// TODO: Implement JWT-based CSRF protection if needed

// API routes - with debugging to identify problematic routes
const routes = [
  { path: "/auth", router: authRoutes, name: "authRoutes" },
  { path: "/api/keys", router: apiKeyRoutes, name: "apiKeyRoutes" },
  { path: "/api/containers", router: containerRoutes, name: "containerRoutes" },
  { path: "/api/docker", router: dockerRoutes, name: "dockerRoutes" },
  { path: "/api/settings/self-backup", router: selfBackupSettingsRoutes, name: "selfBackupSettingsRoutes" },
  { path: "/api/settings/system", router: systemSettingsRoutes, name: "systemSettingsRoutes" },
  { path: "/api/settings/azure", router: azureSettingsRoutes, name: "azureSettingsRoutes" },
  { path: "/api/settings/cloudflare", router: cloudflareSettingsRoutes, name: "cloudflareSettingsRoutes" },
  { path: "/api/settings/github", router: githubSettingsRoutes, name: "githubSettingsRoutes" },
  { path: "/api/settings/github-app", router: githubAppSettingsRoutes, name: "githubAppSettingsRoutes" },
  { path: "/api/github-app", router: githubAppResourcesRoutes, name: "githubAppResourcesRoutes" },
  { path: "/api/github/bug-report", router: githubBugReportRoutes, name: "githubBugReportRoutes" },
  { path: "/api/settings/connectivity", router: settingsConnectivityRoutes, name: "settingsConnectivityRoutes" },
  { path: "/api/settings/validate", router: settingsValidationRoutes, name: "settingsValidationRoutes" },
  { path: "/api/settings/security", router: settingsSecurityRoutes, name: "settingsSecurityRoutes" },
  { path: "/api/settings/docker-host", router: settingsDockerRoutes, name: "settingsDockerRoutes" },
  { path: "/api/settings", router: settingsRoutes, name: "settingsRoutes" },
  { path: "/api/connectivity/azure", router: azureConnectivityRoutes, name: "azureConnectivityRoutes" },
  { path: "/api/connectivity", router: cloudflareConnectivityRoutes, name: "cloudflareConnectivityRoutes" },
  { path: "/api/postgres/databases", router: postgresDatabasesRoutes, name: "postgresDatabasesRoutes" },
  { path: "/api/postgres/backup-configs", router: postgresBackupConfigsRoutes, name: "postgresBackupConfigsRoutes" },
  { path: "/api/postgres", router: postgresBackupsRoutes, name: "postgresBackupsRoutes" },
  { path: "/api/postgres", router: postgresRestoreRoutes, name: "postgresRestoreRoutes" },
  { path: "/api/postgres/progress", router: postgresProgressRoutes, name: "postgresProgressRoutes" },
  { path: "/api/user", router: userPreferencesRoutes, name: "userPreferencesRoutes" },
  { path: "/api/deployment-infrastructure", router: deploymentInfrastructureRoutes, name: "deploymentInfrastructureRoutes" },
  { path: "/api/deployments", router: deploymentsRoutes, name: "deploymentsRoutes" },
  { path: "/api/deployments", router: deploymentDnsRoutes, name: "deploymentDnsRoutes" },
  { path: "/api/deployments", router: haproxyFrontendsRoutes, name: "haproxyFrontendsRoutes (deployment)" },
  { path: "/api/haproxy/frontends", router: haproxyFrontendsRoutes, name: "haproxyFrontendsRoutes (generic)" },
  { path: "/api/haproxy/manual-frontends", router: manualHaproxyFrontendsRoutes, name: "manualHaproxyFrontendsRoutes" },
  { path: "/api/haproxy/backends", router: haproxyBackendsRoutes, name: "haproxyBackendsRoutes" },
  { path: "/api/environments", router: environmentsRoutes, name: "environmentsRoutes" },
  { path: "/api/self-backups", router: selfBackupsRoutes, name: "selfBackupsRoutes" },
  { path: "/api/registry-credentials", router: registryCredentialsRoutes, name: "registryCredentialsRoutes" },
  { path: "/api/postgres-server/servers", router: postgresServerRoutes, name: "postgresServerRoutes" },
  { path: "/api/postgres-server/grants", router: postgresServerGrantsRoutes, name: "postgresServerGrantsRoutes" },
  { path: "/api/postgres-server/workflows", router: postgresServerWorkflowsRoutes, name: "postgresServerWorkflowsRoutes" },
  { path: "/api/tls", router: tlsSettingsRoutes, name: "tlsSettingsRoutes" },
  { path: "/api/tls/certificates", router: tlsCertificatesRoutes, name: "tlsCertificatesRoutes" },
  { path: "/api/tls/renewals", router: tlsRenewalsRoutes, name: "tlsRenewalsRoutes" },
  { path: "/api/events", router: eventsRoutes, name: "eventsRoutes" },
  { path: "/api/monitoring", router: monitoringRoutes, name: "monitoringRoutes" },
  { path: "/api/permission-presets", router: permissionPresetsRoutes, name: "permissionPresetsRoutes" },
  { path: "/api/stacks", router: stacksRoutes, name: "stacksRoutes" },
  { path: "/api/stack-templates", router: stackTemplatesRoutes, name: "stackTemplatesRoutes" },
  { path: "/api/self-update", router: selfUpdateRoutes, name: "selfUpdateRoutes" },
];

// Agent routes are always registered — the settings endpoint must be accessible
// to configure the API key, and session endpoints return 503 when the service is null.
routes.push({ path: "/api/agent", router: agentRoutes, name: "agentRoutes" });

for (const route of routes) {
  try {
    console.log(`Registering route: ${route.name} at path: ${route.path}`);
    app.use(route.path, route.router);
    console.log(`✓ Successfully registered: ${route.name}`);
  } catch (error) {
    console.error(`✗ Failed to register route: ${route.name} at path: ${route.path}`);
    console.error(`Error:`, error);
    throw error;
  }
}

// Serve static files in production
if (appConfig.server.nodeEnv === "production") {
  // In production (container), use process.cwd() to reliably locate public directory
  // __dirname in compiled code may be nested (e.g., /app/server/dist/server/src)
  // but process.cwd() is the working directory where the app started (/app/server)
  const publicPath = path.join(process.cwd(), "public");
  console.log("Setting up static file serving...");
  console.log("Serving static files from:", publicPath);
  // Express 5: Explicitly set dotfiles option (default changed from 'allow' to 'ignore')
  // Currently no .well-known or dotfiles need to be served
  app.use(
    express.static(publicPath, {
      dotfiles: "ignore", // Explicit for Express 5 compliance
    }),
  );
  console.log("✓ Static file serving configured");

  console.log("Registering catch-all SPA route...");
  // Handle client-side routing for SPA
  // Express 5: Use /*path for catch-all routes (path-to-regexp v6 syntax)
  try {
    const indexPath = path.join(publicPath, "index.html");
    app.get("/*path", ((req: Request, res: Response, next: NextFunction) => {
      // Skip API routes and static assets
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
    console.log("✓ Catch-all SPA route registered successfully");
  } catch (error) {
    console.error("✗ Failed to register catch-all route:", error);
    throw error;
  }
}

// Development welcome message
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

// 404 handler for unmatched routes
app.use(notFoundHandler as RequestHandler);

// Global error handling middleware (must be last) - Express 5 compliant
app.use(errorHandler);

export default app;
// Foreign keys enabled via DATABASE_URL parameter
