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
import appConfig from "./lib/config-new";
import { httpLogger } from "./lib/logger-factory";
import { requestIdMiddleware } from "./lib/request-id";
import { helmetMiddleware } from "./lib/security";
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

// Security middleware
app.use(helmetMiddleware);

// CORS configuration
app.use(
  cors({
    origin:
      appConfig.server.publicUrl ||
      (appConfig.server.nodeEnv === "development" ? true : false),
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
import settingsRoutes from "./routes/settings";
import azureSettingsRoutes from "./routes/azure-settings";
import azureConnectivityRoutes from "./routes/azure-connectivity";
import cloudflareSettingsRoutes from "./routes/cloudflare-settings";
import cloudflareConnectivityRoutes from "./routes/cloudflare-connectivity";
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

// JWT-based authentication doesn't require CSRF protection for now
// TODO: Implement JWT-based CSRF protection if needed

// API routes
app.use("/auth", authRoutes);
app.use("/api/keys", apiKeyRoutes);
app.use("/api/containers", containerRoutes);
app.use("/api/settings/self-backup", selfBackupSettingsRoutes);
app.use("/api/settings/system", systemSettingsRoutes);
app.use("/api/settings/azure", azureSettingsRoutes);
app.use("/api/settings/cloudflare", cloudflareSettingsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/connectivity/azure", azureConnectivityRoutes);
app.use("/api/connectivity", cloudflareConnectivityRoutes);
app.use("/api/postgres/databases", postgresDatabasesRoutes);
app.use("/api/postgres/backup-configs", postgresBackupConfigsRoutes);
app.use("/api/postgres", postgresBackupsRoutes);
app.use("/api/postgres", postgresRestoreRoutes);
app.use("/api/postgres/progress", postgresProgressRoutes);
app.use("/api/user", userPreferencesRoutes);
app.use("/api/deployment-infrastructure", deploymentInfrastructureRoutes);
app.use("/api/deployments", deploymentsRoutes);
app.use("/api/deployments", deploymentDnsRoutes);
app.use("/api/deployments", haproxyFrontendsRoutes); // Mount for deployment config-specific routes
app.use("/api/haproxy/frontends", haproxyFrontendsRoutes); // Mount for generic HAProxy management
app.use("/api/haproxy/manual-frontends", manualHaproxyFrontendsRoutes); // Mount for manual frontend management
app.use("/api/environments", environmentsRoutes);
app.use("/api/self-backups", selfBackupsRoutes);
app.use("/api/registry-credentials", registryCredentialsRoutes);
app.use("/api/postgres-server/servers", postgresServerRoutes);
app.use("/api/postgres-server/grants", postgresServerGrantsRoutes);
app.use("/api/postgres-server/workflows", postgresServerWorkflowsRoutes);
app.use("/api/tls", tlsSettingsRoutes);
app.use("/api/tls/certificates", tlsCertificatesRoutes);
app.use("/api/tls/renewals", tlsRenewalsRoutes);

// Serve static files in production
if (appConfig.server.nodeEnv === "production") {
  // Express 5: Explicitly set dotfiles option (default changed from 'allow' to 'ignore')
  // Currently no .well-known or dotfiles need to be served
  app.use(
    express.static(path.join(__dirname, "../public"), {
      dotfiles: "ignore", // Explicit for Express 5 compliance
    }),
  );

  // Handle client-side routing for SPA
  app.get("/*", ((req: Request, res: Response, next: NextFunction) => {
    // Skip API routes
    if (
      req.path.startsWith("/api") ||
      req.path.startsWith("/auth") ||
      req.path.startsWith("/health")
    ) {
      return next();
    }

    res.sendFile(path.join(__dirname, "../public/index.html"));
  }) as RequestHandler);
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

// Graceful shutdown handling
const appLoggerInstance = httpLogger(); // Use HTTP logger for shutdown messages since they relate to server lifecycle

process.on("SIGTERM", () => {
  appLoggerInstance.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  appLoggerInstance.info("SIGINT received, shutting down gracefully");
  process.exit(0);
});

export default app;
// Foreign keys enabled via DATABASE_URL parameter
