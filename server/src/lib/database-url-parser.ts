import path from "path";
import { URL } from "url";

/**
 * Parse SQLite DATABASE_URL and extract the file path
 * Handles formats like:
 * - file:./dev.db
 * - file:./data/dev.db
 * - file:./dev.db?connection_limit=1
 * - file:/absolute/path/to/dev.db
 *
 * IMPORTANT: Prisma resolves relative paths relative to the schema.prisma file location,
 * not relative to process.cwd(). This function mimics that behavior.
 *
 * @param databaseUrl - The DATABASE_URL environment variable value
 * @param schemaDir - The directory containing schema.prisma (defaults to prisma/ relative to cwd)
 * @returns Absolute path to the database file
 * @throws Error if the URL format is invalid or not a file: protocol
 */
export function parseSqliteDatabaseUrl(
  databaseUrl: string | undefined,
  schemaDir: string = path.join(process.cwd(), "prisma")
): string {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  // Check if it starts with file:
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(`DATABASE_URL must use file: protocol for SQLite, got: ${databaseUrl}`);
  }

  // Remove the "file:" prefix
  let filePath = databaseUrl.substring(5);

  // Split by ? to remove query parameters
  const queryIndex = filePath.indexOf("?");
  if (queryIndex !== -1) {
    filePath = filePath.substring(0, queryIndex);
  }

  // Handle relative vs absolute paths
  // If it starts with / it's absolute (or relative to working dir on Windows)
  // If it starts with ./ or ../ it's relative
  // Otherwise treat as relative
  if (filePath.startsWith("/") && process.platform !== "win32") {
    // Absolute path on Unix-like systems
    return filePath;
  } else {
    // Relative path - resolve relative to Prisma schema directory (mimics Prisma's behavior)
    return path.resolve(schemaDir, filePath);
  }
}

/**
 * Get the database file path from the DATABASE_URL environment variable
 * Uses the current process.cwd() as the base for relative paths
 *
 * @returns Absolute path to the database file
 * @throws Error if DATABASE_URL is not set or invalid
 */
export function getDatabaseFilePath(): string {
  return parseSqliteDatabaseUrl(process.env.DATABASE_URL);
}
