import express, { Request, Response } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";

// Import configuration and utilities
import config from "./lib/config.js";
import logger from "./lib/logger.js";
import { requestIdMiddleware } from "./lib/request-id.js";
import { helmetMiddleware, rateLimitMiddleware } from "./lib/security.js";
import { errorHandler, notFoundHandler } from "./lib/error-handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: express.Application = express();

// Trust proxy if behind reverse proxy (for rate limiting and IP detection)
app.set("trust proxy", true);

// Request correlation ID middleware (must be first)
app.use(requestIdMiddleware);

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
app.use(rateLimitMiddleware);

// CORS configuration
app.use(
  cors({
    origin:
      config.CORS_ORIGIN || (config.NODE_ENV === "development" ? true : false),
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Session configuration (for authentication)
app.use(
  session({
    secret:
      config.SESSION_SECRET ||
      "default-development-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
    name: "mini-infra.session",
  }),
);

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
    uptime: process.uptime(),
  });
});

// Import routes
import authRoutes from "./routes/auth.js";

// API routes
app.use("/auth", authRoutes);

// Serve static files in production
if (config.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../public")));

  // Handle client-side routing for SPA
  app.get("*", (req: Request, res: Response, next) => {
    // Skip API routes
    if (
      req.path.startsWith("/api") ||
      req.path.startsWith("/auth") ||
      req.path.startsWith("/health")
    ) {
      return next();
    }

    res.sendFile(path.join(__dirname, "../public/index.html"));
  });
}

// Development welcome message
if (config.NODE_ENV === "development") {
  app.get("/", (req: Request, res: Response) => {
    res.json({
      message: "Mini Infra API Server",
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
      docs: "/health for health check",
    });
  });
}

// 404 handler for unmatched routes
app.use(notFoundHandler);

// Global error handling middleware (must be last)
app.use(errorHandler);

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
