import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { prismaLogger } from "./logger-factory";
import { getDatabaseFilePath } from "./database-url-parser";

// Re-export PrismaClient type for use by other modules
export { PrismaClient };

const isTestEnvironment = process.env.NODE_ENV === "test";

// Enable WAL journal mode for better concurrent read/write performance.
// WAL allows readers to proceed without blocking writers and vice versa,
// which is important for backup operations and general application responsiveness.
if (!isTestEnvironment) {
  try {
    const dbPath = getDatabaseFilePath();
    const db = new Database(dbPath);
    const result = db.pragma("journal_mode = WAL");
    db.close();
    console.log(`[STARTUP] SQLite journal_mode set to: ${JSON.stringify(result)}`);
  } catch (err) {
    console.warn("[STARTUP] Failed to set SQLite WAL mode:", err);
  }
}

declare global {
  // Prevent multiple instances of Prisma Client in development
  var prisma: PrismaClient | undefined;
}

// Create Prisma logger instance
const logger = !isTestEnvironment ? prismaLogger() : null;

const prisma =
  globalThis.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "test"
        ? []
        : [
          {
            emit: "event",
            level: "query",
          },
          {
            emit: "event",
            level: "info",
          },
          {
            emit: "event",
            level: "warn",
          },
          {
            emit: "event",
            level: "error",
          },
        ],
  } as any);

// Set up Prisma event listeners to route logs to dedicated logger
if (!isTestEnvironment && logger) {
  (prisma as any).$on("query", (e: any) => {
    logger.debug(
      {
        query: e.query,
        params: e.params,
        duration: `${e.duration}ms`,
        target: e.target,
      },
      "Prisma Query",
    );
  });

  (prisma as any).$on("info", (e: any) => {
    logger.info(
      {
        message: e.message,
        target: e.target,
      },
      "Prisma Info",
    );
  });

  (prisma as any).$on("warn", (e: any) => {
    logger.warn(
      {
        message: e.message,
        target: e.target,
      },
      "Prisma Warning",
    );
  });

  (prisma as any).$on("error", (e: any) => {
    logger.error(
      {
        message: e.message,
        target: e.target,
      },
      "Prisma Error",
    );
  });
}

if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;

export default prisma;
