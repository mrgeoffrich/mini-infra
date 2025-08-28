import app from "./app";
import config from "./lib/config";
import logger from "./lib/logger";

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

// Graceful shutdown
const gracefulShutdown = (signal: string) => {
  logger.info(`${signal} received, starting graceful shutdown`);

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
