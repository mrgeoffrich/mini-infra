import { PrismaClient } from "../generated/prisma";
import { prismaLogger } from "./logger-factory";

// Re-export PrismaClient type for use by other modules
export { PrismaClient };

declare global {
  // Prevent multiple instances of Prisma Client in development
  var prisma: PrismaClient | undefined;
}

// Create Prisma logger instance
const logger = prismaLogger();

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
if (process.env.NODE_ENV !== "test") {
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
