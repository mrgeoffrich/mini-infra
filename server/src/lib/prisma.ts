import { Prisma, PrismaClient } from "../generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { getLogger } from "./logger-factory";
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
const logger = !isTestEnvironment ? getLogger("db", "prisma") : null;

// Prisma 7 driver adapters resolve relative file: URLs against process.cwd(),
// whereas the legacy query engine resolved them against the schema directory.
// Normalize to an absolute path so behavior matches pre-7 regardless of cwd.
const databaseUrl = `file:${getDatabaseFilePath()}`;

const adapter = new PrismaBetterSqlite3({ url: databaseUrl });

const prismaOptions: Prisma.PrismaClientOptions = {
  adapter,
  log: isTestEnvironment
    ? []
    : [
      { emit: "event", level: "info" },
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
};

const basePrisma = new PrismaClient(prismaOptions);

// Typed event listener helper. Prisma's `$on` signature is dynamic based on
// log levels configured above, so we use a narrow cast at the boundary here.
type PrismaEventListener = (
  event: "info" | "warn" | "error",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma's event payload shape depends on the level; using any at the boundary and narrowing below
  callback: (e: any) => void,
) => void;

// Route engine-level log events + per-query timing to the pino logger.
// Under Prisma 7, queries don't fire a "query" event through the log emitter
// when running via a driver adapter — the query engine is bypassed — so we
// observe queries via $extends instead. info/warn/error still flow through $on.
function instrumentPrisma(client: PrismaClient): PrismaClient {
  if (isTestEnvironment || !logger) return client;

  const onEvent = (client as unknown as { $on: PrismaEventListener }).$on.bind(client);
  onEvent("info", (e: { message: string; target: string }) => {
    logger.info({ message: e.message, target: e.target }, "Prisma Info");
  });
  onEvent("warn", (e: { message: string; target: string }) => {
    logger.warn({ message: e.message, target: e.target }, "Prisma Warning");
  });
  onEvent("error", (e: { message: string; target: string }) => {
    logger.error({ message: e.message, target: e.target }, "Prisma Error");
  });

  return client.$extends({
    query: {
      async $allOperations({ operation, model, args, query }) {
        const start = Date.now();
        try {
          const result = await query(args);
          logger.debug(
            { model, operation, duration: `${Date.now() - start}ms` },
            "Prisma Query",
          );
          return result;
        } catch (err) {
          logger.error({ model, operation, err }, "Prisma Query Error");
          throw err;
        }
      },
    },
  }) as unknown as PrismaClient;
}

const prisma = globalThis.prisma ?? instrumentPrisma(basePrisma);

if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;

export default prisma;
