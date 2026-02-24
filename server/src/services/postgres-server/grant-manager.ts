import { Client } from "pg";
import prisma from "../../lib/prisma";
import { appLogger } from "../../lib/logger-factory";
import postgresServerService from "./server-manager";
import CryptoJS from "crypto-js";

const logger = appLogger();

/**
 * GrantManagementService - Manages database access permissions
 * Handles granting and revoking permissions for users on databases
 */
export class GrantManagementService {
  private readonly encryptionSecret: string | undefined;

  constructor(encryptionSecret?: string) {
    this.encryptionSecret = encryptionSecret || process.env.ENCRYPTION_SECRET;
  }

  /**
   * Get the encryption secret, throwing if not configured
   */
  private getEncryptionSecret(): string {
    if (!this.encryptionSecret) {
      throw new Error(
        "ENCRYPTION_SECRET environment variable is not set. " +
          "It is required for PostgreSQL credential encryption. " +
          "Set it in your .env file."
      );
    }
    return this.encryptionSecret;
  }

  /**
   * Decrypt a connection string
   */
  private decryptConnectionString(encryptedString: string): string {
    const bytes = CryptoJS.AES.decrypt(encryptedString, this.getEncryptionSecret());
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  /**
   * Get a PostgreSQL client for a specific database
   */
  private async getDatabaseClient(server: any, databaseName: string): Promise<Client> {
    const baseConnectionString = this.decryptConnectionString(server.connectionString);
    // Replace the database name in the connection string
    const dbConnectionString = baseConnectionString.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
    return new Client({ connectionString: dbConnectionString });
  }
  /**
   * Create a grant (give user access to database with permissions)
   */
  async createGrant(
    serverId: string,
    userId: string,
    params: {
      databaseId: string;
      managedUserId: string;
      canConnect?: boolean;
      canCreate?: boolean;
      canTemp?: boolean;
      canCreateSchema?: boolean;
      canUsageSchema?: boolean;
      canSelect?: boolean;
      canInsert?: boolean;
      canUpdate?: boolean;
      canDelete?: boolean;
    }
  ) {
    logger.info({ serverId, databaseId: params.databaseId, managedUserId: params.managedUserId }, "Creating grant");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // Get database and user
    const database = await prisma.managedDatabase.findFirst({
      where: { id: params.databaseId, serverId },
    });

    if (!database) {
      throw new Error("Database not found");
    }

    const user = await prisma.managedDatabaseUser.findFirst({
      where: { id: params.managedUserId, serverId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Create grant in database first
    const grant = await prisma.databaseGrant.create({
      data: {
        databaseId: params.databaseId,
        userId: params.managedUserId,
        canConnect: params.canConnect !== false,
        canCreate: params.canCreate || false,
        canTemp: params.canTemp || false,
        canCreateSchema: params.canCreateSchema || false,
        canUsageSchema: params.canUsageSchema !== false,
        canSelect: params.canSelect !== false,
        canInsert: params.canInsert !== false,
        canUpdate: params.canUpdate !== false,
        canDelete: params.canDelete !== false,
      },
    });

    // Apply grants to PostgreSQL server
    await this.applyGrantToServer(serverId, userId, grant.id);

    logger.info({ serverId, grantId: grant.id }, "Grant created and applied");
    return grant;
  }

  /**
   * Apply a grant to the PostgreSQL server
   */
  async applyGrantToServer(serverId: string, userId: string, grantId: string) {
    const grant = await prisma.databaseGrant.findUnique({
      where: { id: grantId },
      include: {
        database: {
          include: {
            server: true,
          },
        },
        user: true,
      },
    });

    if (!grant) {
      throw new Error("Grant not found");
    }

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      const dbName = grant.database.databaseName;
      const username = grant.user.username;

      // Grant CONNECT privilege
      if (grant.canConnect) {
        await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${username}"`);
      }

      // Grant CREATE privilege on database
      if (grant.canCreate) {
        await client.query(`GRANT CREATE ON DATABASE "${dbName}" TO "${username}"`);
      }

      // Grant TEMP privilege
      if (grant.canTemp) {
        await client.query(`GRANT TEMP ON DATABASE "${dbName}" TO "${username}"`);
      }

      await client.end();

      // Get a new client connected to the specific database
      const server = grant.database.server;
      const dbClient = await this.getDatabaseClient(server, dbName);
      await dbClient.connect();

      try {
        // Grant schema privileges
        if (grant.canUsageSchema) {
          await dbClient.query(`GRANT USAGE ON SCHEMA public TO "${username}"`);
        }

        if (grant.canCreateSchema) {
          await dbClient.query(`GRANT CREATE ON SCHEMA public TO "${username}"`);
        }

        // Build table privileges
        const tablePrivileges = [];
        if (grant.canSelect) tablePrivileges.push("SELECT");
        if (grant.canInsert) tablePrivileges.push("INSERT");
        if (grant.canUpdate) tablePrivileges.push("UPDATE");
        if (grant.canDelete) tablePrivileges.push("DELETE");

        if (tablePrivileges.length > 0) {
          const privilegesList = tablePrivileges.join(", ");
          await dbClient.query(`GRANT ${privilegesList} ON ALL TABLES IN SCHEMA public TO "${username}"`);
          // Grant on future tables
          await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privilegesList} ON TABLES TO "${username}"`);
        }

        // Grant sequence privileges (for auto-increment columns)
        if (grant.canInsert || grant.canUpdate) {
          await dbClient.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${username}"`);
          await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${username}"`);
        }

        await dbClient.end();
      } catch (error) {
        await dbClient.end();
        throw error;
      }

      await client.end();

      logger.info({ serverId, grantId, database: dbName, user: username }, "Grant applied to server");
    } catch (error: any) {
      await client.end();
      logger.error({ error: error.message, serverId, grantId }, "Failed to apply grant");
      throw new Error(`Failed to apply grant: ${error.message}`);
    }
  }

  /**
   * Update an existing grant
   */
  async updateGrant(
    userId: string,
    grantId: string,
    updates: {
      canConnect?: boolean;
      canCreate?: boolean;
      canTemp?: boolean;
      canCreateSchema?: boolean;
      canUsageSchema?: boolean;
      canSelect?: boolean;
      canInsert?: boolean;
      canUpdate?: boolean;
      canDelete?: boolean;
    }
  ) {
    const grant = await prisma.databaseGrant.findUnique({
      where: { id: grantId },
      include: {
        database: {
          include: {
            server: true,
          },
        },
        user: true,
      },
    });

    if (!grant) {
      throw new Error("Grant not found");
    }

    const serverId = grant.database.serverId;

    logger.info({ serverId, grantId, updates }, "Updating grant");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // First revoke all existing permissions
    await this.revokeGrantFromServer(serverId, userId, grantId);

    // Update grant in database
    const updatedGrant = await prisma.databaseGrant.update({
      where: { id: grantId },
      data: updates,
    });

    // Apply new permissions
    await this.applyGrantToServer(serverId, userId, grantId);

    logger.info({ serverId, grantId }, "Grant updated");
    return updatedGrant;
  }

  /**
   * Revoke a grant from the PostgreSQL server
   */
  async revokeGrantFromServer(serverId: string, userId: string, grantId: string) {
    const grant = await prisma.databaseGrant.findUnique({
      where: { id: grantId },
      include: {
        database: {
          include: {
            server: true,
          },
        },
        user: true,
      },
    });

    if (!grant) {
      throw new Error("Grant not found");
    }

    try {
      const dbName = grant.database.databaseName;
      const username = grant.user.username;
      const server = grant.database.server;

      // Connect to the specific database
      const dbClient = await this.getDatabaseClient(server, dbName);
      await dbClient.connect();

      try {
        // Revoke table privileges
        await dbClient.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "${username}"`);
        await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "${username}"`);

        // Revoke sequence privileges
        await dbClient.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "${username}"`);
        await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "${username}"`);

        // Revoke schema privileges
        await dbClient.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM "${username}"`);

        await dbClient.end();
      } catch (error) {
        await dbClient.end();
        throw error;
      }

      // Revoke database-level privileges using a new client to postgres db
      const client = await postgresServerService.getClient(serverId, userId);
      try {
        await client.query(`REVOKE ALL PRIVILEGES ON DATABASE "${dbName}" FROM "${username}"`);
        await client.end();
      } catch (error) {
        await client.end();
        throw error;
      }

      logger.info({ serverId, grantId, database: dbName, user: username }, "Grant revoked from server");
    } catch (error: any) {
      logger.error({ error: error.message, serverId, grantId }, "Failed to revoke grant");
      throw new Error(`Failed to revoke grant: ${error.message}`);
    }
  }

  /**
   * Delete a grant (revoke and remove from database)
   */
  async deleteGrant(userId: string, grantId: string) {
    const grant = await prisma.databaseGrant.findUnique({
      where: { id: grantId },
      include: {
        database: {
          include: {
            server: true,
          },
        },
      },
    });

    if (!grant) {
      throw new Error("Grant not found");
    }

    const serverId = grant.database.serverId;

    logger.info({ serverId, grantId }, "Deleting grant");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // Revoke from server first
    await this.revokeGrantFromServer(serverId, userId, grantId);

    // Delete from database
    await prisma.databaseGrant.delete({
      where: { id: grantId },
    });

    logger.info({ serverId, grantId }, "Grant deleted");
  }

  /**
   * List grants for a database
   */
  async listGrantsForDatabase(serverId: string, userId: string, databaseId: string) {
    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    return await prisma.databaseGrant.findMany({
      where: { databaseId },
      include: {
        user: true,
        database: true,
      },
      orderBy: {
        user: {
          username: "asc",
        },
      },
    });
  }

  /**
   * List grants for a user
   */
  async listGrantsForUser(serverId: string, userId: string, managedUserId: string) {
    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    return await prisma.databaseGrant.findMany({
      where: { userId: managedUserId },
      include: {
        user: true,
        database: true,
      },
      orderBy: {
        database: {
          databaseName: "asc",
        },
      },
    });
  }

  /**
   * Get grant details
   */
  async getGrantDetails(userId: string, grantId: string) {
    const grant = await prisma.databaseGrant.findUnique({
      where: { id: grantId },
      include: {
        user: true,
        database: {
          include: {
            server: true,
          },
        },
      },
    });

    if (!grant) {
      throw new Error("Grant not found");
    }

    // Verify server ownership
    await postgresServerService.getServer(grant.database.serverId, userId);

    return grant;
  }
}

export default new GrantManagementService();
