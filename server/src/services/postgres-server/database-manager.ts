import { Client } from "pg";
import prisma from "../../lib/prisma";
import { appLogger } from "../../lib/logger-factory";
import postgresServerService from "./server-manager";

const logger = appLogger();

/**
 * DatabaseManagementService - Manages databases on PostgreSQL servers
 * Handles database creation, deletion, syncing, and metadata retrieval
 */
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
      throw new Error(`Failed to list databases: ${error.message}`);
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
      // Note: We cannot use parameterized queries for DDL statements
      const encoding = params.encoding || "UTF8";
      const template = params.template || "template0";
      const owner = params.owner || "postgres";
      const connectionLimit = params.connectionLimit !== undefined ? params.connectionLimit : -1;

      // Sanitize database name (alphanumeric, underscores, hyphens only)
      const sanitizedDbName = params.databaseName.replace(/[^a-zA-Z0-9_-]/g, "");
      if (sanitizedDbName !== params.databaseName) {
        throw new Error("Database name contains invalid characters");
      }

      let createQuery = `CREATE DATABASE "${sanitizedDbName}" ENCODING '${encoding}' TEMPLATE ${template}`;

      if (params.collation) {
        createQuery += ` LC_COLLATE '${params.collation}'`;
      }

      if (params.owner) {
        createQuery += ` OWNER "${params.owner}"`;
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
      throw new Error(`Failed to create database: ${error.message}`);
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
      await client.query(`DROP DATABASE IF EXISTS "${managedDatabase.databaseName}"`);

      await client.end();

      // Delete managed database record (grants will be cascade deleted)
      await prisma.managedDatabase.delete({
        where: { id: databaseId },
      });

      logger.info({ serverId, databaseId, databaseName: managedDatabase.databaseName }, "Database dropped");
    } catch (error: any) {
      await client.end();
      logger.error({ error: error.message, serverId, databaseId }, "Failed to drop database");
      throw new Error(`Failed to drop database: ${error.message}`);
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
      throw new Error(`Failed to get database size: ${error.message}`);
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
