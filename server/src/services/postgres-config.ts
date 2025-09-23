import prisma, { PrismaClient } from "../lib/prisma";
import { Client as PostgresClient } from "pg";
import CryptoJS from "crypto-js";
import { servicesLogger } from "../lib/logger-factory";
import {
  PostgresDatabase,
  PostgresDatabaseInfo,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  DatabaseConnectionConfig,
  DatabaseValidationResult,
  DatabaseHealthCheckResult,
  DatabaseHealthStatus,
  PostgreSSLMode,
  PostgresDatabaseFilter,
  PostgresDatabaseSortOptions,
  DiscoverDatabasesRequest,
  DatabaseInfo,
} from "@mini-infra/types";

export class DatabaseConfigService {
  private prisma: PrismaClient;
  private encryptionKey: string;

  constructor(prisma: PrismaClient, encryptionKey?: string) {
    this.prisma = prisma;
    // Use provided encryption key or default from env
    this.encryptionKey =
      encryptionKey || process.env.API_KEY_SECRET || "default-key";
  }

  // ====================
  // Encryption Utilities
  // ====================

  /**
   * Encrypt a connection string
   * @param connectionString - Plain text connection string
   * @returns Encrypted connection string
   */
  private encryptConnectionString(connectionString: string): string {
    try {
      return CryptoJS.AES.encrypt(
        connectionString,
        this.encryptionKey,
      ).toString();
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to encrypt connection string",
      );
      throw new Error("Encryption failed");
    }
  }

  /**
   * Decrypt a connection string
   * @param encryptedConnectionString - Encrypted connection string
   * @returns Plain text connection string
   */
  private decryptConnectionString(encryptedConnectionString: string): string {
    try {
      const bytes = CryptoJS.AES.decrypt(
        encryptedConnectionString,
        this.encryptionKey,
      );
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      if (!decrypted) {
        throw new Error("Decryption resulted in empty string");
      }
      return decrypted;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to decrypt connection string",
      );
      throw new Error("Decryption failed");
    }
  }

  /**
   * Build a PostgreSQL connection string from configuration
   * @param config - Database connection configuration
   * @returns PostgreSQL connection string
   */
  private buildConnectionString(config: DatabaseConnectionConfig): string {
    const { host, port, database, username, password, sslMode } = config;
    return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslMode}`;
  }

  /**
   * Parse a PostgreSQL connection string
   * @param connectionString - PostgreSQL connection string
   * @returns Database connection configuration
   */
  private parseConnectionString(
    connectionString: string,
  ): DatabaseConnectionConfig {
    try {
      const url = new URL(connectionString);
      const sslMode = url.searchParams.get("sslmode") || "prefer";

      return {
        host: url.hostname,
        port: parseInt(url.port) || 5432,
        database: url.pathname.slice(1), // Remove leading slash
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        sslMode: sslMode as PostgreSSLMode,
      };
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to parse connection string",
      );
      throw new Error("Invalid connection string format");
    }
  }

  // ====================
  // Database CRUD Operations
  // ====================

  /**
   * Create a new database configuration
   * @param request - Database creation request
   * @returns Created database information
   */
  async createDatabase(
    request: CreatePostgresDatabaseRequest,
  ): Promise<PostgresDatabaseInfo> {
    try {
      // Validate input
      this.validateDatabaseRequest(request);

      // Build and encrypt connection string
      const config: DatabaseConnectionConfig = {
        host: request.host,
        port: request.port,
        database: request.database,
        username: request.username,
        password: request.password,
        sslMode: request.sslMode,
      };

      const connectionString = this.buildConnectionString(config);
      const encryptedConnectionString =
        this.encryptConnectionString(connectionString);

      // Check for duplicate name system-wide
      const existingDb = await this.prisma.postgresDatabase.findUnique({
        where: {
          name: request.name,
        },
      });

      if (existingDb) {
        throw new Error(
          `Database configuration with name '${request.name}' already exists`,
        );
      }

      // Create database configuration
      const createdDb = await this.prisma.postgresDatabase.create({
        data: {
          name: request.name,
          connectionString: encryptedConnectionString,
          host: request.host,
          port: request.port,
          database: request.database,
          username: request.username,
          sslMode: request.sslMode,
          tags: JSON.stringify(request.tags || []),
          healthStatus: "unknown",
        },
      });

      servicesLogger().info(
        {
          databaseId: createdDb.id,
          name: createdDb.name,
          host: createdDb.host,
        },
        "Database configuration created",
      );

      return this.toDatabaseInfo(createdDb);
    } catch (error) {
      servicesLogger().error(
        {
          name: request.name,
          host: request.host,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to create database configuration",
      );
      throw error;
    }
  }

  /**
   * Update an existing database configuration
   * @param databaseId - Database ID to update
   * @param request - Database update request
   * @returns Updated database information
   */
  async updateDatabase(
    databaseId: string,
    request: UpdatePostgresDatabaseRequest,
  ): Promise<PostgresDatabaseInfo> {
    try {
      // Get existing database
      const existingDb = await this.prisma.postgresDatabase.findUnique({
        where: { id: databaseId },
      });

      if (!existingDb) {
        throw new Error("Database configuration not found");
      }

      // Prepare update data
      const updateData: any = {
        updatedAt: new Date(),
      };

      // Update connection string if any connection details changed
      let needsConnectionStringUpdate = false;
      let currentConfig: DatabaseConnectionConfig;

      if (
        request.host ||
        request.port ||
        request.database ||
        request.username ||
        request.password ||
        request.sslMode
      ) {
        // Decrypt current connection string to get current config
        const currentConnectionString = this.decryptConnectionString(
          existingDb.connectionString,
        );
        currentConfig = this.parseConnectionString(currentConnectionString);

        // Update config with new values
        const newConfig: DatabaseConnectionConfig = {
          host: request.host || currentConfig.host,
          port: request.port || currentConfig.port,
          database: request.database || currentConfig.database,
          username: request.username || currentConfig.username,
          password: request.password || currentConfig.password,
          sslMode: request.sslMode || currentConfig.sslMode,
        };

        // Build and encrypt new connection string
        const newConnectionString = this.buildConnectionString(newConfig);
        updateData.connectionString =
          this.encryptConnectionString(newConnectionString);

        // Update individual fields
        updateData.host = newConfig.host;
        updateData.port = newConfig.port;
        updateData.database = newConfig.database;
        updateData.username = newConfig.username;
        updateData.sslMode = newConfig.sslMode;

        // Reset health status when connection details change
        updateData.healthStatus = "unknown";
        updateData.lastHealthCheck = null;
        needsConnectionStringUpdate = true;
      }

      // Update other fields
      if (request.name) {
        // Check for duplicate name system-wide
        const existingWithName = await this.prisma.postgresDatabase.findUnique({
          where: {
            name: request.name,
          },
        });

        if (existingWithName && existingWithName.id !== databaseId) {
          throw new Error(
            `Database configuration with name '${request.name}' already exists`,
          );
        }

        updateData.name = request.name;
      }

      if (request.tags !== undefined) {
        updateData.tags = JSON.stringify(request.tags);
      }

      // Update database
      const updatedDb = await this.prisma.postgresDatabase.update({
        where: { id: databaseId },
        data: updateData,
      });

      servicesLogger().info(
        {
          databaseId: updatedDb.id,
          name: updatedDb.name,
          connectionStringUpdated: needsConnectionStringUpdate,
        },
        "Database configuration updated",
      );

      return this.toDatabaseInfo(updatedDb);
    } catch (error) {
      servicesLogger().error(
        {
          databaseId: databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update database configuration",
      );
      throw error;
    }
  }

  /**
   * Get a database configuration by ID
   * @param databaseId - Database ID
   * @returns Database information or null if not found
   */
  async getDatabaseById(
    databaseId: string,
  ): Promise<PostgresDatabaseInfo | null> {
    try {
      const database = await this.prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
        },
      });

      if (!database) {
        return null;
      }

      return this.toDatabaseInfo(database);
    } catch (error) {
      servicesLogger().error(
        {
          databaseId: databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get database configuration",
      );
      throw error;
    }
  }

  /**
   * List database configurations with filtering and sorting
   * @param filter - Optional filter criteria
   * @param sort - Optional sort options
   * @param limit - Optional limit for pagination
   * @param offset - Optional offset for pagination
   * @returns List of database configurations
   */
  async listDatabases(
    filter?: PostgresDatabaseFilter,
    sort?: PostgresDatabaseSortOptions,
    limit?: number,
    offset?: number,
  ): Promise<PostgresDatabaseInfo[]> {
    try {
      // Build where clause
      const where: any = {};

      if (filter) {
        if (filter.name) {
          where.name = {
            contains: filter.name,
            mode: "insensitive",
          };
        }

        if (filter.host) {
          where.host = {
            contains: filter.host,
            mode: "insensitive",
          };
        }

        if (filter.healthStatus) {
          where.healthStatus = filter.healthStatus;
        }

        if (filter.tags && filter.tags.length > 0) {
          // Search for any of the provided tags in the JSON array
          where.OR = filter.tags.map((tag) => ({
            tags: {
              contains: `"${tag}"`,
            },
          }));
        }
      }

      // Build order by clause
      let orderBy: any = { createdAt: "desc" }; // Default sort

      if (sort) {
        const sortField = sort.field === "tags" ? "name" : sort.field; // Can't sort by JSON field
        orderBy = { [sortField]: sort.order };
      }

      // Query databases
      const databases = await this.prisma.postgresDatabase.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
      });

      return databases.map((db: any) => this.toDatabaseInfo(db));
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to list database configurations",
      );
      throw error;
    }
  }

  /**
   * Delete a database configuration
   * @param databaseId - Database ID to delete
   */
  async deleteDatabase(databaseId: string): Promise<void> {
    try {
      // Verify existence
      const database = await this.prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
        },
      });

      if (!database) {
        throw new Error("Database configuration not found");
      }

      // Delete database configuration (cascade will handle related records)
      await this.prisma.postgresDatabase.delete({
        where: { id: databaseId },
      });

      servicesLogger().info(
        {
          databaseId: databaseId,
          name: database.name,
        },
        "Database configuration deleted",
      );
    } catch (error) {
      servicesLogger().error(
        {
          databaseId: databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to delete database configuration",
      );
      throw error;
    }
  }

  // ====================
  // Connection Testing and Health Checks
  // ====================

  /**
   * Test database connection
   * @param config - Database connection configuration
   * @returns Validation result
   */
  async testConnection(
    config: DatabaseConnectionConfig,
  ): Promise<DatabaseValidationResult> {
    const startTime = Date.now();
    let client: PostgresClient | null = null;

    try {
      const connectionString = this.buildConnectionString(config);

      client = new PostgresClient({
        connectionString,
        connectionTimeoutMillis: 10000, // 10 second timeout
        query_timeout: 5000, // 5 second query timeout
      });

      await client.connect();

      // Test basic functionality
      const result = await client.query("SELECT version(), current_database()");
      const responseTimeMs = Date.now() - startTime;

      const serverVersion = result.rows[0]?.version;
      const databaseName = result.rows[0]?.current_database;

      servicesLogger().info(
        {
          host: config.host,
          port: config.port,
          database: config.database,
          responseTimeMs,
        },
        "Database connection test successful",
      );

      return {
        isValid: true,
        message: "Connection successful",
        responseTimeMs,
        serverVersion,
        databaseName,
        metadata: {
          host: config.host,
          port: config.port,
          database: config.database,
          sslMode: config.sslMode,
        },
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      let errorCode = "CONNECTION_FAILED";
      if (errorMessage.includes("timeout")) {
        errorCode = "TIMEOUT";
      } else if (errorMessage.includes("authentication")) {
        errorCode = "AUTHENTICATION_FAILED";
      } else if (errorMessage.includes("does not exist")) {
        errorCode = "DATABASE_NOT_FOUND";
      } else if (errorMessage.includes("refused")) {
        errorCode = "CONNECTION_REFUSED";
      }

      servicesLogger().warn(
        {
          host: config.host,
          port: config.port,
          database: config.database,
          errorMessage,
          errorCode,
          responseTimeMs,
        },
        "Database connection test failed",
      );

      return {
        isValid: false,
        message: errorMessage,
        errorCode,
        responseTimeMs,
        metadata: {
          host: config.host,
          port: config.port,
          database: config.database,
          sslMode: config.sslMode,
        },
      };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (endError) {
          servicesLogger().warn(
            {
              error:
                endError instanceof Error ? endError.message : "Unknown error",
            },
            "Failed to close database connection",
          );
        }
      }
    }
  }

  /**
   * Test connection for an existing database configuration
   * @param databaseId - Database ID
   * @returns Validation result
   */
  async testDatabaseConnection(
    databaseId: string,
  ): Promise<DatabaseValidationResult> {
    try {
      // Get database configuration
      const database = await this.prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
        },
      });

      if (!database) {
        throw new Error("Database configuration not found");
      }

      // Decrypt connection string
      const connectionString = this.decryptConnectionString(
        database.connectionString,
      );
      const config = this.parseConnectionString(connectionString);

      // Test connection
      const result = await this.testConnection(config);

      // Update health status based on test result
      await this.updateHealthStatus(databaseId, result);

      return result;
    } catch (error) {
      servicesLogger().error(
        {
          databaseId: databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to test database connection",
      );
      throw error;
    }
  }

  /**
   * Perform health check for a database
   * @param databaseId - Database ID
   * @returns Health check result
   */
  async performHealthCheck(
    databaseId: string,
  ): Promise<DatabaseHealthCheckResult> {
    try {
      const database = await this.prisma.postgresDatabase.findUnique({
        where: { id: databaseId },
      });

      if (!database) {
        throw new Error("Database configuration not found");
      }

      // Decrypt connection string
      const connectionString = this.decryptConnectionString(
        database.connectionString,
      );
      const config = this.parseConnectionString(connectionString);

      // Test connection
      const validationResult = await this.testConnection(config);

      // Determine health status
      const healthStatus: DatabaseHealthStatus = validationResult.isValid
        ? "healthy"
        : "unhealthy";

      // Update database health status
      await this.prisma.postgresDatabase.update({
        where: { id: databaseId },
        data: {
          healthStatus,
          lastHealthCheck: new Date(),
        },
      });

      const result: DatabaseHealthCheckResult = {
        databaseId,
        healthStatus,
        lastChecked: new Date(),
        responseTime: validationResult.responseTimeMs,
        errorMessage: validationResult.isValid
          ? undefined
          : validationResult.message,
        errorCode: validationResult.errorCode,
        serverVersion: validationResult.serverVersion,
        metadata: validationResult.metadata,
      };

      servicesLogger().info(
        {
          databaseId,
          healthStatus,
          responseTime: result.responseTime,
        },
        "Database health check completed",
      );

      return result;
    } catch (error) {
      servicesLogger().error(
        {
          databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to perform database health check",
      );
      throw error;
    }
  }

  /**
   * Get decrypted connection configuration for a database
   * @param databaseId - Database ID
   * @returns Database connection configuration
   */
  async getConnectionConfig(
    databaseId: string,
  ): Promise<DatabaseConnectionConfig> {
    try {
      // Get database record
      const database = await this.prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
        },
      });

      if (!database) {
        throw new Error("Database not found");
      }

      // Decrypt connection string and parse configuration
      const connectionString = this.decryptConnectionString(
        database.connectionString,
      );
      return this.parseConnectionString(connectionString);
    } catch (error) {
      servicesLogger().error(
        {
          databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get connection configuration",
      );
      throw error;
    }
  }

  /**
   * Discover available databases on a PostgreSQL server
   * @param request - Database discovery request with connection details
   * @returns List of databases available on the server
   */
  async discoverDatabases(
    request: DiscoverDatabasesRequest,
  ): Promise<{ databases: DatabaseInfo[]; serverVersion?: string; responseTimeMs: number }> {
    const startTime = Date.now();
    let client: PostgresClient | null = null;

    try {
      // Create connection config to connect to postgres database for discovery
      const connectionConfig: DatabaseConnectionConfig = {
        ...request,
        database: "postgres", // Use default postgres database for discovery
      };

      const connectionString = this.buildConnectionString(connectionConfig);

      client = new PostgresClient({
        connectionString,
        connectionTimeoutMillis: 10000, // 10 second timeout
        query_timeout: 5000, // 5 second query timeout
      });

      await client.connect();

      // Get server version
      const versionResult = await client.query("SELECT version()");
      const serverVersion = versionResult.rows[0]?.version;

      // Query for databases - exclude template databases by default
      const databasesQuery = `
        SELECT
          datname as name,
          datistemplate as is_template,
          datallowconn as allow_connections,
          pg_encoding_to_char(encoding) as encoding,
          datcollate as collation,
          datctype as character_classification,
          pg_size_pretty(pg_database_size(datname)) as size_pretty,
          (SELECT description FROM pg_shdescription WHERE objoid = d.oid) as description
        FROM pg_database d
        WHERE datallowconn = true
          AND datistemplate = false
          AND datname NOT IN ('postgres')
        ORDER BY datname;
      `;

      const result = await client.query(databasesQuery);
      const responseTimeMs = Date.now() - startTime;

      const databases: DatabaseInfo[] = result.rows.map((row) => ({
        name: row.name,
        isTemplate: row.is_template,
        allowConnections: row.allow_connections,
        encoding: row.encoding,
        collation: row.collation,
        characterClassification: row.character_classification,
        sizePretty: row.size_pretty,
        description: row.description,
      }));

      servicesLogger().info(
        {
          host: request.host,
          port: request.port,
          databaseCount: databases.length,
          responseTimeMs,
        },
        "Database discovery completed successfully",
      );

      return {
        databases,
        serverVersion,
        responseTimeMs,
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().warn(
        {
          host: request.host,
          port: request.port,
          errorMessage,
          responseTimeMs,
        },
        "Database discovery failed",
      );

      throw error;
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (endError) {
          servicesLogger().warn(
            {
              error:
                endError instanceof Error ? endError.message : "Unknown error",
            },
            "Failed to close database connection during discovery",
          );
        }
      }
    }
  }

  // ====================
  // Utility Methods
  // ====================

  /**
   * Update health status for a database based on validation result
   * @param databaseId - Database ID
   * @param validationResult - Validation result from connection test
   */
  private async updateHealthStatus(
    databaseId: string,
    validationResult: DatabaseValidationResult,
  ): Promise<void> {
    try {
      const healthStatus: DatabaseHealthStatus = validationResult.isValid
        ? "healthy"
        : "unhealthy";

      await this.prisma.postgresDatabase.update({
        where: { id: databaseId },
        data: {
          healthStatus,
          lastHealthCheck: new Date(),
        },
      });
    } catch (error) {
      servicesLogger().error(
        {
          databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update health status",
      );
    }
  }

  /**
   * Convert database record to info object for API responses
   * @param database - Database record from Prisma
   * @returns Database info object
   */
  private toDatabaseInfo(database: PostgresDatabase): PostgresDatabaseInfo {
    return {
      id: database.id,
      name: database.name,
      connectionString: "[ENCRYPTED]", // Never expose encrypted connection string
      host: database.host,
      port: database.port,
      database: database.database,
      username: database.username,
      sslMode: database.sslMode,
      tags: JSON.parse(database.tags || "[]"),
      createdAt: database.createdAt.toISOString(),
      updatedAt: database.updatedAt.toISOString(),
      lastHealthCheck: database.lastHealthCheck?.toISOString() || null,
      healthStatus: database.healthStatus as DatabaseHealthStatus,
    };
  }

  /**
   * Validate database request fields
   * @param request - Database creation request
   */
  private validateDatabaseRequest(
    request: CreatePostgresDatabaseRequest,
  ): void {
    if (!request.name || request.name.trim().length === 0) {
      throw new Error("Database name is required");
    }

    if (!request.host || request.host.trim().length === 0) {
      throw new Error("Host is required");
    }

    if (!request.port || request.port < 1 || request.port > 65535) {
      throw new Error("Port must be between 1 and 65535");
    }

    if (!request.database || request.database.trim().length === 0) {
      throw new Error("Database name is required");
    }

    if (!request.username || request.username.trim().length === 0) {
      throw new Error("Username is required");
    }

    if (!request.password || request.password.trim().length === 0) {
      throw new Error("Password is required");
    }

    if (!["require", "disable", "prefer"].includes(request.sslMode)) {
      throw new Error("SSL mode must be 'require', 'disable', or 'prefer'");
    }

    // Validate name format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(request.name)) {
      throw new Error(
        "Database name can only contain letters, numbers, hyphens, and underscores",
      );
    }

    if (request.name.length > 100) {
      throw new Error("Database name must be 100 characters or less");
    }
  }
}
