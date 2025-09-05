import app from "./app";
import config from "./lib/config";
import { appLogger } from "./lib/logger-factory";

// Use app logger for server startup
const logger = appLogger();
import DockerService from "./services/docker";
import { ConnectivityScheduler } from "./lib/connectivity-scheduler";
import prisma from "./lib/prisma";

// Global connectivity scheduler instance
let connectivityScheduler: ConnectivityScheduler | null = null;

// Initialize Docker connection and connectivity scheduler before starting server
const initializeServices = async () => {
  try {
    // Initialize Docker service
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();

    // Initialize connectivity scheduler
    connectivityScheduler = new ConnectivityScheduler(
      prisma,
      config.CONNECTIVITY_CHECK_INTERVAL,
    );
    connectivityScheduler.start();

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

  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        environment: config.NODE_ENV,
        logLevel: config.LOG_LEVEL,
      },
      `🚀 Mini Infra server started on port ${config.PORT}`,
    );

    if (config.NODE_ENV === "development") {
      logger.info(
        `📊 Health check available at: http://localhost:${config.PORT}/health`,
      );
    }
  });

  return server;
};

// Start the application
startServer()
  .then((server) => {
    // Graceful shutdown
    const gracefulShutdown = (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown`);

      // Stop connectivity scheduler first
      if (connectivityScheduler) {
        connectivityScheduler.stop();
        logger.info("Connectivity scheduler stopped");
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
  logger.fatal({ error: err }, "Uncaught Exception");
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.fatal(
    {
      reason,
      promise: promise.toString(),
    },
    "Unhandled Promise Rejection",
  );
  process.exit(1);
});
