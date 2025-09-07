import app from "./app";
import appConfig from "./lib/config-new";
import { appLogger, clearLoggerCache, serializeError } from "./lib/logger-factory";

// Clear logger cache on startup to ensure new configuration is loaded
clearLoggerCache();

// Use app logger for server startup
const logger = appLogger();
import DockerService from "./services/docker";
import { ConnectivityScheduler } from "./lib/connectivity-scheduler";
import { BackupSchedulerService } from "./services/backup-scheduler";
import { initializeDevApiKey } from "./services/dev-api-key";
import prisma from "./lib/prisma";

// Global scheduler instances
let connectivityScheduler: ConnectivityScheduler | null = null;
let backupScheduler: BackupSchedulerService | null = null;

// Initialize Docker connection and connectivity scheduler before starting server
const initializeServices = async () => {
  try {
    // Initialize Docker service
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();

    // Initialize connectivity scheduler
    connectivityScheduler = new ConnectivityScheduler(
      prisma,
      appConfig.connectivity.checkInterval,
    );
    connectivityScheduler.start();

    // Initialize backup scheduler
    backupScheduler = new BackupSchedulerService(prisma);
    BackupSchedulerService.setInstance(backupScheduler);
    await backupScheduler.initialize();

    // Initialize development API key (development mode only)
    const devApiKeyResult = await initializeDevApiKey();
    if (devApiKeyResult) {
      if (devApiKeyResult.isNewKey) {
        logger.info(
          {
            userId: devApiKeyResult.userId,
            keyId: devApiKeyResult.keyId,
          },
          "🔑 Development API key created for Claude",
        );
        logger.info(
          `🔑 Claude API Key: ${devApiKeyResult.apiKey}`,
        );
        logger.info(
          "💡 Use this API key in Authorization header: Bearer <key> or x-api-key header",
        );
      } else {
        logger.info(
          {
            userId: devApiKeyResult.userId,
            keyId: devApiKeyResult.keyId,
          },
          "🔑 Development API key already exists for Claude",
        );
        logger.info(
          "💡 Use 'npm run show-dev-key' to display the API key information",
        );
      }
    }

    logger.info("All services initialized successfully");
  } catch (error) {
    logger.fatal(
      {
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "Failed to initialize services - shutting down",
    );
    process.exit(1);
  }
};

// Start server after successful service initialization
const startServer = async () => {
  await initializeServices();

  const server = app.listen(appConfig.server.port, () => {
    logger.info(
      {
        port: appConfig.server.port,
        environment: appConfig.server.nodeEnv,
        logLevel: appConfig.logging.level,
      },
      `🚀 Mini Infra server started on port ${appConfig.server.port}`,
    );

    if (appConfig.server.nodeEnv === "development") {
      logger.info(
        `📊 Health check available at: http://localhost:${appConfig.server.port}/health`,
      );
    }
  });

  return server;
};

// Start the application
startServer()
  .then((server) => {
    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown`);

      // Stop schedulers
      if (connectivityScheduler) {
        connectivityScheduler.stop();
        logger.info("Connectivity scheduler stopped");
      }
      
      if (backupScheduler) {
        await backupScheduler.shutdown();
        logger.info("Backup scheduler stopped");
      }

      server.close((err) => {
        if (err) {
          logger.error({ error: err }, "Error during server shutdown");
          process.exit(1);
        }

        logger.info("Server closed successfully");
        process.exit(0);
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error("Forced shutdown after 30 seconds");
        process.exit(1);
      }, 30000);
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  })
  .catch((error) => {
    logger.fatal({ error }, "Failed to start server");
    process.exit(1);
  });

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.fatal(
    {
      error: serializeError(err),
      errorType: err?.constructor?.name || "Unknown",
      pid: process.pid,
    },
    "Uncaught Exception - Server shutting down"
  );
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.fatal(
    {
      reason: serializeError(reason),
      reasonType: reason?.constructor?.name || typeof reason,
      promise: promise.toString(),
      pid: process.pid,
    },
    "Unhandled Promise Rejection - Server shutting down",
  );
  process.exit(1);
});
