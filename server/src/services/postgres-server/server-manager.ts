import { Client } from "pg";
import prisma from "../../lib/prisma";
import CryptoJS from "crypto-js";
import { appLogger } from "../../lib/logger-factory";
import { getEncryptionSecret } from "../../lib/security-config";
import databaseManagerService from "./database-manager";
import userManagerService from "./user-manager";

const logger = appLogger();

/**
 * PostgresServerService - Manages PostgreSQL server connections and operations
 * Handles CRUD operations, connection testing, health checks, and encryption
 */
export class PostgresServerService {

  /**
   * Encrypt a connection string using AES encryption
   */
  private encryptConnectionString(connectionString: string): string {
    return CryptoJS.AES.encrypt(connectionString, getEncryptionSecret()).toString();
  }

  /**
   * Decrypt a connection string
   */
  private decryptConnectionString(encryptedString: string): string {
    const bytes = CryptoJS.AES.decrypt(encryptedString, getEncryptionSecret());
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  /**
   * Parse tags from JSON string to array
   */
  private parseTags(tagsJson: string | null): string[] {
    if (!tagsJson) return [];
    try {
      const parsed = JSON.parse(tagsJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Transform server data to include parsed tags
   */
  private transformServer<T extends { tags: string | null }>(server: T): Omit<T, 'tags'> & { tags: string[] } {
    const { tags, ...rest } = server;
    return {
      ...rest,
      tags: this.parseTags(tags),
    } as Omit<T, 'tags'> & { tags: string[] };
  }

  /**
   * Build connection string from components
   */
  private buildConnectionString(
    host: string,
    port: number,
    username: string,
    password: string,
    database: string = "postgres",
    sslMode: string = "prefer"
  ): string {
    return `postgresql://${username}:${password}@${host}:${port}/${database}?sslmode=${sslMode}`;
  }

  /**
   * Create a new PostgreSQL server connection
   */
  async createServer(params: {
    name: string;
    host: string;
    port: number;
    adminUsername: string;
    adminPassword: string;
    sslMode: string;
    tags?: string[];
    linkedContainerId?: string;
    linkedContainerName?: string;
    userId: string;
  }) {
    logger.info({ params: { ...params, adminPassword: "***" } }, "Creating PostgreSQL server");

    // Build and encrypt connection string
    const connectionString = this.buildConnectionString(
      params.host,
      params.port,
      params.adminUsername,
      params.adminPassword,
      "postgres",
      params.sslMode
    );
    const encryptedConnectionString = this.encryptConnectionString(connectionString);

    // Create server record
    const server = await prisma.postgresServer.create({
      data: {
        name: params.name,
        host: params.host,
        port: params.port,
        adminUsername: params.adminUsername,
        connectionString: encryptedConnectionString,
        sslMode: params.sslMode,
        tags: params.tags ? JSON.stringify(params.tags) : null,
        linkedContainerId: params.linkedContainerId,
        linkedContainerName: params.linkedContainerName,
        userId: params.userId,
      },
    });

    logger.info({ serverId: server.id, name: server.name }, "PostgreSQL server created");

    // Perform initial sync of databases and users
    const syncResults = {
      databasesSync: { success: false, count: 0, error: undefined as string | undefined },
      usersSync: { success: false, count: 0, error: undefined as string | undefined },
    };

    // Sync databases
    try {
      logger.info({ serverId: server.id }, "Performing initial database sync");
      const dbSyncResult = await databaseManagerService.syncDatabases(server.id, params.userId);
      syncResults.databasesSync = { success: true, count: dbSyncResult.synced, error: undefined };
      logger.info({ serverId: server.id, count: dbSyncResult.synced }, "Initial database sync completed");
    } catch (error) {
      logger.error({ serverId: server.id, error: (error instanceof Error ? error.message : String(error)) }, "Initial database sync failed");
      syncResults.databasesSync = { success: false, count: 0, error: (error instanceof Error ? error.message : String(error)) };
    }

    // Sync users
    try {
      logger.info({ serverId: server.id }, "Performing initial user sync");
      const userSyncResult = await userManagerService.syncUsers(server.id, params.userId);
      syncResults.usersSync = { success: true, count: userSyncResult.synced, error: undefined };
      logger.info({ serverId: server.id, count: userSyncResult.synced }, "Initial user sync completed");
    } catch (error) {
      logger.error({ serverId: server.id, error: (error instanceof Error ? error.message : String(error)) }, "Initial user sync failed");
      syncResults.usersSync = { success: false, count: 0, error: (error instanceof Error ? error.message : String(error)) };
    }

    return { server: this.transformServer(server), syncResults };
  }

  /**
   * Get all servers for a user
   */
  async listServers(userId: string) {
    const servers = await prisma.postgresServer.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            databases: true,
            users: true,
          },
        },
      },
    });
    return servers.map(server => this.transformServer(server));
  }

  /**
   * Get a specific server by ID
   */
  async getServer(serverId: string, userId: string) {
    const server = await prisma.postgresServer.findFirst({
      where: { id: serverId, userId },
      include: {
        _count: {
          select: {
            databases: true,
            users: true,
          },
        },
      },
    });

    if (!server) {
      throw new Error("Server not found");
    }

    return this.transformServer(server);
  }

  /**
   * Update a server
   */
  async updateServer(
    serverId: string,
    userId: string,
    updates: {
      name?: string;
      host?: string;
      port?: number;
      adminUsername?: string;
      adminPassword?: string;
      sslMode?: string;
      tags?: string[];
      linkedContainerId?: string | null;
      linkedContainerName?: string | null;
    }
  ) {
    logger.info({ serverId, updates: { ...updates, adminPassword: updates.adminPassword ? "***" : undefined } }, "Updating server");

    // Get existing server
    const existingServer = await this.getServer(serverId, userId);

    // If password or connection details changed, rebuild connection string
    let encryptedConnectionString = existingServer.connectionString;
    if (updates.adminPassword || updates.host || updates.port || updates.adminUsername || updates.sslMode) {
      const host = updates.host || existingServer.host;
      const port = updates.port || existingServer.port;
      const username = updates.adminUsername || existingServer.adminUsername;
      const sslMode = updates.sslMode || existingServer.sslMode;

      // If no new password provided, decrypt existing connection string to extract password
      let password = updates.adminPassword;
      if (!password) {
        const existingConnectionString = this.decryptConnectionString(existingServer.connectionString);
        const match = existingConnectionString.match(/postgresql:\/\/[^:]+:([^@]+)@/);
        password = match ? match[1] : "";
      }

      const connectionString = this.buildConnectionString(host, port, username, password, "postgres", sslMode);
      encryptedConnectionString = this.encryptConnectionString(connectionString);
    }

    // Update server
    const server = await prisma.postgresServer.update({
      where: { id: serverId },
      data: {
        ...(updates.name && { name: updates.name }),
        ...(updates.host && { host: updates.host }),
        ...(updates.port && { port: updates.port }),
        ...(updates.adminUsername && { adminUsername: updates.adminUsername }),
        ...(updates.sslMode && { sslMode: updates.sslMode }),
        ...(updates.linkedContainerId !== undefined && { linkedContainerId: updates.linkedContainerId }),
        ...(updates.linkedContainerName !== undefined && { linkedContainerName: updates.linkedContainerName }),
        ...(updates.tags && { tags: JSON.stringify(updates.tags) }),
        connectionString: encryptedConnectionString,
      },
    });

    logger.info({ serverId }, "Server updated");
    return this.transformServer(server);
  }

  /**
   * Delete a server
   */
  async deleteServer(serverId: string, userId: string) {
    logger.info({ serverId }, "Deleting server");

    const server = await this.getServer(serverId, userId);

    await prisma.postgresServer.delete({
      where: { id: serverId },
    });

    logger.info({ serverId, name: server.name }, "Server deleted");
  }

  /**
   * Test connection to a PostgreSQL server
   */
  async testConnection(params: {
    host: string;
    port: number;
    username: string;
    password: string;
    sslMode: string;
  }): Promise<{ success: boolean; version?: string; error?: string }> {
    const connectionString = this.buildConnectionString(
      params.host,
      params.port,
      params.username,
      params.password,
      "postgres",
      params.sslMode
    );

    const client = new Client({ connectionString });

    try {
      await client.connect();
      const result = await client.query("SELECT version()");
      const version = result.rows[0].version;
      await client.end();

      logger.info({ host: params.host, version }, "Connection test successful");
      return { success: true, version };
    } catch (error) {
      logger.error({ error: (error instanceof Error ? error.message : String(error)), host: params.host }, "Connection test failed");
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Test connection for an existing server
   */
  async testServerConnection(serverId: string, userId: string): Promise<{ success: boolean; version?: string; error?: string }> {
    const server = await this.getServer(serverId, userId);
    const connectionString = this.decryptConnectionString(server.connectionString);

    const client = new Client({ connectionString });

    try {
      await client.connect();
      const result = await client.query("SELECT version()");
      const version = result.rows[0].version;
      await client.end();

      // Update health status
      await prisma.postgresServer.update({
        where: { id: serverId },
        data: {
          healthStatus: "healthy",
          lastHealthCheck: new Date(),
          serverVersion: version,
        },
      });

      logger.info({ serverId, version }, "Server connection test successful");
      return { success: true, version };
    } catch (error) {
      // Update health status
      await prisma.postgresServer.update({
        where: { id: serverId },
        data: {
          healthStatus: "unhealthy",
          lastHealthCheck: new Date(),
        },
      });

      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId }, "Server connection test failed");
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Get server info (version, uptime, etc.)
   */
  async getServerInfo(serverId: string, userId: string) {
    const server = await this.getServer(serverId, userId);
    const connectionString = this.decryptConnectionString(server.connectionString);

    const client = new Client({ connectionString });

    try {
      await client.connect();

      // Get version
      const versionResult = await client.query("SELECT version()");
      const version = versionResult.rows[0].version;

      // Get uptime
      const uptimeResult = await client.query("SELECT pg_postmaster_start_time()");
      const startTime = uptimeResult.rows[0].pg_postmaster_start_time;

      // Get database count
      const dbCountResult = await client.query(
        "SELECT count(*) FROM pg_database WHERE datistemplate = false"
      );
      const databaseCount = parseInt(dbCountResult.rows[0].count);

      // Get active connections
      const activeConnectionsResult = await client.query(
        "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'"
      );
      const activeConnections = parseInt(activeConnectionsResult.rows[0].count);

      await client.end();

      return {
        version,
        startTime,
        databaseCount,
        activeConnections,
      };
    } catch (error) {
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId }, "Failed to get server info");
      throw new Error(`Failed to get server info: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * Perform health check on a server
   */
  async performHealthCheck(serverId: string, userId: string) {
    return await this.testServerConnection(serverId, userId);
  }

  /**
   * Get a PostgreSQL client for a server
   * Used by other services to interact with the server
   */
  async getClient(serverId: string, userId: string): Promise<Client> {
    const server = await this.getServer(serverId, userId);
    const connectionString = this.decryptConnectionString(server.connectionString);
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  }

  /**
   * Get a PostgreSQL client connected to a specific database on a server
   * Used by services that need to query specific databases
   */
  async getClientForDatabase(serverId: string, userId: string, databaseName: string): Promise<Client> {
    const server = await this.getServer(serverId, userId);
    const connectionString = this.decryptConnectionString(server.connectionString);

    // Parse and modify connection string to use the specified database
    const url = new URL(connectionString);
    url.pathname = `/${databaseName}`;

    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  /**
   * Get the admin password for a server
   * Used by services that need credentials for backup/migration operations
   */
  async getServerAdminPassword(serverId: string, userId: string): Promise<string> {
    const server = await this.getServer(serverId, userId);
    const connectionString = this.decryptConnectionString(server.connectionString);

    // Parse connection string to extract password
    const url = new URL(connectionString);
    return decodeURIComponent(url.password);
  }
}

export default new PostgresServerService();
