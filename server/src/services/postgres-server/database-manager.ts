import prisma from "../../lib/prisma";
import { appLogger } from "../../lib/logger-factory";
import postgresServerService from "./server-manager";

const logger = appLogger();

/**
 * Escape a SQL identifier by doubling internal double quotes.
 * Prevents SQL injection even for values loaded from the database.
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * DatabaseManagementService - Manages databases on PostgreSQL servers
 * Handles database creation, deletion, syncing, and metadata retrieval
 */
// Allowlist of valid PostgreSQL encodings
const VALID_ENCODINGS = new Set([
  "UTF8", "SQL_ASCII", "LATIN1", "LATIN2", "LATIN3", "LATIN4", "LATIN5",
  "LATIN6", "LATIN7", "LATIN8", "LATIN9", "LATIN10", "WIN1250", "WIN1251",
  "WIN1252", "WIN1253", "WIN1254", "WIN1255", "WIN1256", "WIN1257", "WIN1258",
  "EUC_JP", "EUC_CN", "EUC_KR", "EUC_TW", "EUC_JIS_2004", "SJIS",
  "BIG5", "GBK", "GB18030", "JOHAB", "UHC", "ISO_8859_5", "ISO_8859_6",
  "ISO_8859_7", "ISO_8859_8", "KOI8R", "KOI8U", "MULE_INTERNAL",
]);

// Allowlist of valid PostgreSQL templates
const VALID_TEMPLATES = new Set(["template0", "template1"]);

// Valid PostgreSQL identifier pattern (used for owner, collation values)
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Valid collation pattern (e.g., "en_US.UTF-8", "C", "POSIX", "C.UTF-8")
const VALID_COLLATION = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

export class DatabaseManagementService {
  /**
   * List all databases from the PostgreSQL server
   */
  async listDatabasesFromServer(serverId: string, userId: string) {
    logger.info({ serverId }, "Listing databases from server");

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      const result = await client.query(`
        SELECT
          d.datname as name,
          pg_catalog.pg_get_userbyid(d.datdba) as owner,
          pg_encoding_to_char(d.encoding) as encoding,
          d.datcollate as collation,
          pg_database_size(d.datname) as size_bytes,
          d.datconnlimit as connection_limit
        FROM pg_database d
        WHERE d.datistemplate = false
        ORDER BY d.datname
      `);

      await client.end();

      logger.info({ serverId, count: result.rows.length }, "Databases listed from server");
      return result.rows;
    } catch (error: any) {
      await client.end();
      logger.error({ error: error.message, serverId }, "Failed to list databases from server");
      throw new Error(`Failed to list databases: ${error.message}`, { cause: error });
    }
  }

  /**
   * List managed databases from our database
   */
  async listManagedDatabases(serverId: string, userId: string) {
    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    return await prisma.managedDatabase.findMany({
      where: { serverId },
      orderBy: { databaseName: "asc" },
      include: {
        _count: {
          select: {
            grants: true,
          },
        },
      },
    });
  }

  /**
   * Sync databases from server to our database
   */
  async syncDatabases(serverId: string, userId: string) {
    logger.info({ serverId }, "Syncing databases from server");

    const serverDatabases = await this.listDatabasesFromServer(serverId, userId);

    // Update or create managed database records
    for (const db of serverDatabases) {
      await prisma.managedDatabase.upsert({
        where: {
          serverId_databaseName: {
            serverId,
            databaseName: db.name,
          },
        },
        create: {
          serverId,
          databaseName: db.name,
          owner: db.owner,
          encoding: db.encoding,
          collation: db.collation,
          sizeBytes: db.size_bytes ? BigInt(db.size_bytes) : null,
          connectionLimit: db.connection_limit,
          lastSyncedAt: new Date(),
        },
        update: {
          owner: db.owner,
          encoding: db.encoding,
          collation: db.collation,
          sizeBytes: db.size_bytes ? BigInt(db.size_bytes) : null,
          connectionLimit: db.connection_limit,
          lastSyncedAt: new Date(),
        },
      });
    }

    logger.info({ serverId, count: serverDatabases.length }, "Databases synced");
    return { synced: serverDatabases.length };
  }

  /**
   * Create a new database on the server
   */
  async createDatabase(
    serverId: string,
    userId: string,
    params: {
      databaseName: string;
      owner?: string;
      encoding?: string;
      collation?: string;
      template?: string;
      connectionLimit?: number;
    }
  ) {
    logger.info({ serverId, databaseName: params.databaseName }, "Creating database");

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      // Build CREATE DATABASE statement
      // Note: We cannot use parameterized queries for DDL statements,
      // so we validate all inputs against allowlists to prevent SQL injection
      const encoding = params.encoding || "UTF8";
      const template = params.template || "template0";
      const owner = params.owner || "postgres";
      const connectionLimit = params.connectionLimit !== undefined ? params.connectionLimit : -1;

      // Validate encoding against allowlist
      if (!VALID_ENCODINGS.has(encoding.toUpperCase())) {
        throw new Error(`Invalid encoding: ${encoding}. Must be a valid PostgreSQL encoding.`);
      }

      // Validate template against allowlist
      if (!VALID_TEMPLATES.has(template)) {
        throw new Error(`Invalid template: ${template}. Must be template0 or template1.`);
      }

      // Validate collation format
      if (params.collation && !VALID_COLLATION.test(params.collation)) {
        throw new Error("Collation contains invalid characters");
      }

      // Validate owner (alphanumeric and underscores only, must start with letter or underscore)
      if (!VALID_IDENTIFIER.test(owner)) {
        throw new Error("Owner name contains invalid characters");
      }

      // Sanitize database name (alphanumeric, underscores, hyphens only)
      const sanitizedDbName = params.databaseName.replace(/[^a-zA-Z0-9_-]/g, "");
      if (sanitizedDbName !== params.databaseName) {
        throw new Error("Database name contains invalid characters");
      }

      let createQuery = `CREATE DATABASE ${escapeIdentifier(sanitizedDbName)} ENCODING '${encoding}' TEMPLATE ${template}`;

      if (params.collation) {
        createQuery += ` LC_COLLATE '${params.collation}'`;
      }

      if (params.owner) {
        createQuery += ` OWNER ${escapeIdentifier(owner)}`;
      }

      createQuery += ` CONNECTION LIMIT ${connectionLimit}`;

      await client.query(createQuery);

      // Get database size
      const sizeResult = await client.query(
        `SELECT pg_database_size($1) as size_bytes`,
        [sanitizedDbName]
      );
      const sizeBytes = sizeResult.rows[0].size_bytes;

      await client.end();

      // Create managed database record
      const managedDatabase = await prisma.managedDatabase.create({
        data: {
          serverId,
          databaseName: sanitizedDbName,
          owner,
          encoding,
          collation: params.collation || null,
          template,
          sizeBytes: sizeBytes ? BigInt(sizeBytes) : null,
          connectionLimit,
          lastSyncedAt: new Date(),
        },
      });

      logger.info({ serverId, databaseId: managedDatabase.id, databaseName: sanitizedDbName }, "Database created");
      return managedDatabase;
    } catch (error: any) {
      await client.end();
      logger.error({ error: error.message, serverId, databaseName: params.databaseName }, "Failed to create database");
      throw new Error(`Failed to create database: ${error.message}`, { cause: error });
    }
  }

  /**
   * Drop a database from the server
   */
  async dropDatabase(serverId: string, userId: string, databaseId: string) {
    logger.info({ serverId, databaseId }, "Dropping database");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // Get managed database
    const managedDatabase = await prisma.managedDatabase.findFirst({
      where: { id: databaseId, serverId },
    });

    if (!managedDatabase) {
      throw new Error("Database not found");
    }

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      // Terminate all connections to the database
      await client.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()
      `, [managedDatabase.databaseName]);

      // Drop the database
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(managedDatabase.databaseName)}`);

      await client.end();

      // Delete managed database record (grants will be cascade deleted)
      await prisma.managedDatabase.delete({
        where: { id: databaseId },
      });

      logger.info({ serverId, databaseId, databaseName: managedDatabase.databaseName }, "Database dropped");
    } catch (error: any) {
      await client.end();
      logger.error({ error: error.message, serverId, databaseId }, "Failed to drop database");
      throw new Error(`Failed to drop database: ${error.message}`, { cause: error });
    }
  }

  /**
   * Change database owner
   */
  async changeOwner(
    serverId: string,
    userId: string,
    databaseId: string,
    newOwner: string
  ) {
    logger.info({ serverId, databaseId, newOwner }, "Changing database owner");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // Get managed database
    const managedDatabase = await prisma.managedDatabase.findFirst({
      where: { id: databaseId, serverId },
    });

    if (!managedDatabase) {
      throw new Error("Database not found");
    }

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      // Sanitize inputs (prevent SQL injection)
      const sanitizedDbName = managedDatabase.databaseName.replace(/[^a-zA-Z0-9_-]/g, "");
      const sanitizedOwner = newOwner.replace(/[^a-zA-Z0-9_-]/g, "");

      if (sanitizedDbName !== managedDatabase.databaseName) {
        throw new Error("Database name contains invalid characters");
      }

      if (sanitizedOwner !== newOwner) {
        throw new Error("Owner name contains invalid characters");
      }

      // Change the database owner
      await client.query(`ALTER DATABASE ${escapeIdentifier(sanitizedDbName)} OWNER TO ${escapeIdentifier(sanitizedOwner)}`);

      await client.end();

      // Update managed database record
      const updatedDatabase = await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: {
          owner: newOwner,
        },
      });

      logger.info(
        { serverId, databaseId, databaseName: managedDatabase.databaseName, newOwner },
        "Database owner changed successfully"
      );
      return updatedDatabase;
    } catch (error: any) {
      await client.end();
      logger.error(
        { error: error.message, serverId, databaseId, newOwner },
        "Failed to change database owner"
      );
      throw new Error(`Failed to change database owner: ${error.message}`, { cause: error });
    }
  }

  /**
   * Get database details
   */
  async getDatabaseDetails(serverId: string, userId: string, databaseId: string) {
    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    const managedDatabase = await prisma.managedDatabase.findFirst({
      where: { id: databaseId, serverId },
      include: {
        grants: {
          include: {
            user: true,
          },
        },
        _count: {
          select: {
            grants: true,
          },
        },
      },
    });

    if (!managedDatabase) {
      throw new Error("Database not found");
    }

    return managedDatabase;
  }

  /**
   * Get database size from server
   */
  async getDatabaseSize(serverId: string, userId: string, databaseName: string): Promise<bigint> {
    const client = await postgresServerService.getClient(serverId, userId);

    try {
      const result = await client.query(
        `SELECT pg_database_size($1) as size_bytes`,
        [databaseName]
      );
      await client.end();

      return BigInt(result.rows[0].size_bytes);
    } catch (error: any) {
      await client.end();
      logger.error({ error: error.message, serverId, databaseName }, "Failed to get database size");
      throw new Error(`Failed to get database size: ${error.message}`, { cause: error });
    }
  }

  /**
   * Update database metadata (refresh size, etc.)
   */
  async updateDatabaseMetadata(serverId: string, userId: string, databaseId: string) {
    const managedDatabase = await this.getDatabaseDetails(serverId, userId, databaseId);

    const sizeBytes = await this.getDatabaseSize(serverId, userId, managedDatabase.databaseName);

    const updated = await prisma.managedDatabase.update({
      where: { id: databaseId },
      data: {
        sizeBytes,
        lastSyncedAt: new Date(),
      },
    });

    return updated;
  }
}

export default new DatabaseManagementService();
