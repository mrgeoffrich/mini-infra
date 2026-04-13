import prisma from "../../lib/prisma";
import CryptoJS from "crypto-js";
import { appLogger } from "../../lib/logger-factory";
import { getEncryptionSecret } from "../../lib/security-config";
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
 * UserManagementService - Manages users/roles on PostgreSQL servers
 * Handles user creation, deletion, password management, and syncing
 */
export class UserManagementService {
  /**
   * Encrypt a password using AES encryption
   */
  private encryptPassword(password: string): string {
    return CryptoJS.AES.encrypt(password, getEncryptionSecret()).toString();
  }

  /**
   * List all users/roles from the PostgreSQL server
   */
  async listUsersFromServer(serverId: string, userId: string) {
    logger.info({ serverId }, "Listing users from server");

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      const result = await client.query(`
        SELECT
          rolname as username,
          rolcanlogin as can_login,
          rolsuper as is_superuser,
          rolconnlimit as connection_limit
        FROM pg_roles
        WHERE rolname NOT LIKE 'pg_%'
        ORDER BY rolname
      `);

      await client.end();

      logger.info({ serverId, count: result.rows.length }, "Users listed from server");
      return result.rows;
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId }, "Failed to list users from server");
      throw new Error(`Failed to list users: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * List managed users from our database
   */
  async listManagedUsers(serverId: string, userId: string) {
    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    return await prisma.managedDatabaseUser.findMany({
      where: { serverId },
      orderBy: { username: "asc" },
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
   * Sync users from server to our database
   */
  async syncUsers(serverId: string, userId: string) {
    logger.info({ serverId }, "Syncing users from server");

    const serverUsers = await this.listUsersFromServer(serverId, userId);

    // Update or create managed user records
    for (const user of serverUsers) {
      await prisma.managedDatabaseUser.upsert({
        where: {
          serverId_username: {
            serverId,
            username: user.username,
          },
        },
        create: {
          serverId,
          username: user.username,
          canLogin: user.can_login,
          isSuperuser: user.is_superuser,
          connectionLimit: user.connection_limit,
          lastSyncedAt: new Date(),
        },
        update: {
          canLogin: user.can_login,
          isSuperuser: user.is_superuser,
          connectionLimit: user.connection_limit,
          lastSyncedAt: new Date(),
        },
      });
    }

    logger.info({ serverId, count: serverUsers.length }, "Users synced");
    return { synced: serverUsers.length };
  }

  /**
   * Create a new user on the server
   */
  async createUser(
    serverId: string,
    userId: string,
    params: {
      username: string;
      password: string;
      canLogin?: boolean;
      isSuperuser?: boolean;
      connectionLimit?: number;
    }
  ) {
    logger.info({ serverId, username: params.username }, "Creating user");

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      // Sanitize username (alphanumeric and underscores only)
      const sanitizedUsername = params.username.replace(/[^a-zA-Z0-9_]/g, "");
      if (sanitizedUsername !== params.username) {
        throw new Error("Username contains invalid characters");
      }

      // Build CREATE USER statement
      const canLogin = params.canLogin !== false;
      const isSuperuser = params.isSuperuser || false;
      const connectionLimit = params.connectionLimit !== undefined ? params.connectionLimit : -1;

      // Build CREATE USER statement without password (password set separately via parameterized query)
      let createQuery = `CREATE USER ${escapeIdentifier(sanitizedUsername)}`;

      if (!canLogin) {
        createQuery += " NOLOGIN";
      } else {
        createQuery += " LOGIN";
      }

      if (isSuperuser) {
        createQuery += " SUPERUSER";
      }

      createQuery += ` CONNECTION LIMIT ${connectionLimit}`;

      await client.query(createQuery);

      // Set password separately using parameterized query to prevent SQL injection
      await client.query(`ALTER USER ${escapeIdentifier(sanitizedUsername)} WITH PASSWORD $1`, [params.password]);

      await client.end();

      // Encrypt and store password hash
      const encryptedPassword = this.encryptPassword(params.password);

      // Create managed user record
      const managedUser = await prisma.managedDatabaseUser.create({
        data: {
          serverId,
          username: sanitizedUsername,
          canLogin,
          isSuperuser,
          connectionLimit,
          passwordHash: encryptedPassword,
          passwordSetAt: new Date(),
          lastSyncedAt: new Date(),
        },
      });

      logger.info({ serverId, userId: managedUser.id, username: sanitizedUsername }, "User created");
      return managedUser;
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId, username: params.username }, "Failed to create user");
      throw new Error(`Failed to create user: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * Drop a user from the server
   */
  async dropUser(serverId: string, userId: string, managedUserId: string) {
    logger.info({ serverId, managedUserId }, "Dropping user");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // Get managed user
    const managedUser = await prisma.managedDatabaseUser.findFirst({
      where: { id: managedUserId, serverId },
    });

    if (!managedUser) {
      throw new Error("User not found");
    }

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      // Revoke all privileges first
      const escapedUsername = escapeIdentifier(managedUser.username);
      await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${escapedUsername}`);
      await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${escapedUsername}`);
      await client.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${escapedUsername}`);

      // Drop the user
      await client.query(`DROP USER IF EXISTS ${escapedUsername}`);

      await client.end();

      // Delete managed user record (grants will be cascade deleted)
      await prisma.managedDatabaseUser.delete({
        where: { id: managedUserId },
      });

      logger.info({ serverId, managedUserId, username: managedUser.username }, "User dropped");
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId, managedUserId }, "Failed to drop user");
      throw new Error(`Failed to drop user: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * Change user password
   */
  async changePassword(serverId: string, userId: string, managedUserId: string, newPassword: string) {
    logger.info({ serverId, managedUserId }, "Changing user password");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // Get managed user
    const managedUser = await prisma.managedDatabaseUser.findFirst({
      where: { id: managedUserId, serverId },
    });

    if (!managedUser) {
      throw new Error("User not found");
    }

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      await client.query(`ALTER USER ${escapeIdentifier(managedUser.username)} WITH PASSWORD $1`, [newPassword]);

      await client.end();

      // Encrypt and update password hash
      const encryptedPassword = this.encryptPassword(newPassword);

      await prisma.managedDatabaseUser.update({
        where: { id: managedUserId },
        data: {
          passwordHash: encryptedPassword,
          passwordSetAt: new Date(),
        },
      });

      logger.info({ serverId, managedUserId, username: managedUser.username }, "User password changed");
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId, managedUserId }, "Failed to change user password");
      throw new Error(`Failed to change password: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * Update user attributes
   */
  async updateUser(
    serverId: string,
    userId: string,
    managedUserId: string,
    updates: {
      canLogin?: boolean;
      isSuperuser?: boolean;
      connectionLimit?: number;
    }
  ) {
    logger.info({ serverId, managedUserId, updates }, "Updating user");

    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    // Get managed user
    const managedUser = await prisma.managedDatabaseUser.findFirst({
      where: { id: managedUserId, serverId },
    });

    if (!managedUser) {
      throw new Error("User not found");
    }

    const client = await postgresServerService.getClient(serverId, userId);

    try {
      const alterStatements = [];
      const escapedUsername = escapeIdentifier(managedUser.username);

      if (updates.canLogin !== undefined) {
        alterStatements.push(`ALTER USER ${escapedUsername} WITH ${updates.canLogin ? "LOGIN" : "NOLOGIN"}`);
      }

      if (updates.isSuperuser !== undefined) {
        alterStatements.push(`ALTER USER ${escapedUsername} WITH ${updates.isSuperuser ? "SUPERUSER" : "NOSUPERUSER"}`);
      }

      if (updates.connectionLimit !== undefined) {
        alterStatements.push(`ALTER USER ${escapedUsername} WITH CONNECTION LIMIT ${updates.connectionLimit}`);
      }

      for (const statement of alterStatements) {
        await client.query(statement);
      }

      await client.end();

      // Update managed user record
      const updated = await prisma.managedDatabaseUser.update({
        where: { id: managedUserId },
        data: {
          ...(updates.canLogin !== undefined && { canLogin: updates.canLogin }),
          ...(updates.isSuperuser !== undefined && { isSuperuser: updates.isSuperuser }),
          ...(updates.connectionLimit !== undefined && { connectionLimit: updates.connectionLimit }),
        },
      });

      logger.info({ serverId, managedUserId, username: managedUser.username }, "User updated");
      return updated;
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId, managedUserId }, "Failed to update user");
      throw new Error(`Failed to update user: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * Get user details
   */
  async getUserDetails(serverId: string, userId: string, managedUserId: string) {
    // Verify server ownership
    await postgresServerService.getServer(serverId, userId);

    const managedUser = await prisma.managedDatabaseUser.findFirst({
      where: { id: managedUserId, serverId },
      include: {
        grants: {
          include: {
            database: true,
          },
        },
        _count: {
          select: {
            grants: true,
          },
        },
      },
    });

    if (!managedUser) {
      throw new Error("User not found");
    }

    return managedUser;
  }
}

export default new UserManagementService();
