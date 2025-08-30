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
import config from "./lib/config";
import logger from "./lib/logger";
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
    logger,
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
  }),
);

// Security middleware
app.use(helmetMiddleware);

// CORS configuration
app.use(
  cors({
    origin:
      config.PUBLIC_URL || (config.NODE_ENV === "development" ? true : false),
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

// Health check endpoint
app.get("/health", ((req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
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

// JWT-based authentication doesn't require CSRF protection for now
// TODO: Implement JWT-based CSRF protection if needed

// API routes
app.use("/auth", authRoutes);
app.use("/api/keys", apiKeyRoutes);
app.use("/api/containers", containerRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/settings/azure", azureSettingsRoutes);
app.use("/api/settings/cloudflare", cloudflareSettingsRoutes);
app.use("/api/connectivity/azure", azureConnectivityRoutes);
app.use("/api/connectivity", cloudflareConnectivityRoutes);
app.use("/api/postgres/databases", postgresDatabasesRoutes);
app.use("/api/postgres/backup-configs", postgresBackupConfigsRoutes);
app.use("/api/postgres", postgresBackupsRoutes);

// Serve static files in production
if (config.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../public")));

  // Handle client-side routing for SPA
  app.get("*", ((req: Request, res: Response, next: NextFunction) => {
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
if (config.NODE_ENV === "development") {
  app.get("/", ((req: Request, res: Response) => {
    res.json({
      message: "Mini Infra API Server",
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
      docs: "/health for health check",
    });
  }) as RequestHandler);
}

// 404 handler for unmatched routes
app.use(notFoundHandler as RequestHandler);

// Global error handling middleware (must be last)
app.use(errorHandler as any);

// Graceful shutdown handling
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  process.exit(0);
});

export default app;
