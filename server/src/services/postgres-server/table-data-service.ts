import { Client } from "pg";
import prisma from "../../lib/prisma";
import { appLogger } from "../../lib/logger-factory";
import postgresServerService from "./server-manager";
import type {
  DatabaseTableInfo,
  TableColumnInfo,
  TableDataRequest,
} from "@mini-infra/types";

const logger = appLogger();

/**
 * Escape a SQL identifier by doubling internal double quotes.
 * This is the SQL standard way to safely quote identifiers and prevents
 * SQL injection via values like: my"table; DROP TABLE --
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * TableDataService - Retrieves table metadata and data from PostgreSQL databases
 * Handles table listing, column metadata, and paginated data retrieval
 */
export class TableDataService {
  /**
   * Get list of tables in a database with metadata
   */
  async getTableList(serverId: string, userId: string, databaseId: string): Promise<DatabaseTableInfo[]> {
    logger.info({ serverId, databaseId }, "Getting table list");

    // Verify database exists and user has access
    const database = await prisma.managedDatabase.findFirst({
      where: {
        id: databaseId,
        serverId,
        server: { userId },
      },
    });

    if (!database) {
      throw new Error("Database not found");
    }

    // Get a client connection to the specific database
    const client = await this.getDatabaseClient(serverId, userId, database.databaseName);

    try {
      // Query for table metadata from information_schema and pg_catalog
      const result = await client.query(`
        SELECT
          t.table_name as name,
          t.table_schema as schema,
          t.table_type as table_type,
          pg_total_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)) as size_bytes,
          (
            SELECT
              CASE
                WHEN reltuples < 0 THEN NULL
                ELSE reltuples::bigint
              END
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = t.table_name
            AND n.nspname = t.table_schema
          ) as row_count,
          obj_description((quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass) as last_modified
        FROM information_schema.tables t
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.table_schema, t.table_name
      `);

      await client.end();

      const tables: DatabaseTableInfo[] = result.rows.map((row) => ({
        name: row.name,
        schema: row.schema,
        rowCount: row.row_count ? parseInt(row.row_count, 10) : null,
        sizeBytes: row.size_bytes ? parseInt(row.size_bytes, 10) : null,
        tableType: row.table_type as DatabaseTableInfo["tableType"],
        lastModified: row.last_modified || null,
      }));

      logger.info({ serverId, databaseId, count: tables.length }, "Table list retrieved");
      return tables;
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId, databaseId }, "Failed to get table list");
      throw new Error(`Failed to get table list: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * Get column metadata for a table
   */
  async getTableColumns(
    serverId: string,
    userId: string,
    databaseId: string,
    tableName: string
  ): Promise<TableColumnInfo[]> {
    logger.info({ serverId, databaseId, tableName }, "Getting table columns");

    const database = await prisma.managedDatabase.findFirst({
      where: {
        id: databaseId,
        serverId,
        server: { userId },
      },
    });

    if (!database) {
      throw new Error("Database not found");
    }

    const client = await this.getDatabaseClient(serverId, userId, database.databaseName);

    try {
      // Parse schema and table name (format: schema.table or just table)
      const { schema, table } = this.parseTableName(tableName);

      // Query for column metadata
      const result = await client.query(
        `
        SELECT
          c.column_name as name,
          c.data_type as data_type,
          c.is_nullable = 'YES' as is_nullable,
          c.column_default as default_value,
          c.ordinal_position as ordinal_position,
          c.character_maximum_length as max_length,
          EXISTS(
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_name = c.table_name
              AND kcu.column_name = c.column_name
              AND tc.table_schema = c.table_schema
          ) as is_primary_key
        FROM information_schema.columns c
        WHERE c.table_name = $1
          AND c.table_schema = $2
        ORDER BY c.ordinal_position
      `,
        [table, schema]
      );

      await client.end();

      if (result.rows.length === 0) {
        throw new Error("Table not found");
      }

      const columns: TableColumnInfo[] = result.rows.map((row) => ({
        name: row.name,
        dataType: row.data_type,
        isNullable: row.is_nullable,
        defaultValue: row.default_value,
        isPrimaryKey: row.is_primary_key,
        ordinalPosition: row.ordinal_position,
        maxLength: row.max_length,
      }));

      logger.info({ serverId, databaseId, tableName, count: columns.length }, "Table columns retrieved");
      return columns;
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId, databaseId, tableName }, "Failed to get table columns");
      throw error;
    }
  }

  /**
   * Get paginated data from a table with optional filtering and sorting
   */
  async getTableData(
    serverId: string,
    userId: string,
    databaseId: string,
    tableName: string,
    params: TableDataRequest
  ) {
    logger.info({ serverId, databaseId, tableName, params }, "Getting table data");

    const database = await prisma.managedDatabase.findFirst({
      where: {
        id: databaseId,
        serverId,
        server: { userId },
      },
    });

    if (!database) {
      throw new Error("Database not found");
    }

    // Get columns first
    const columns = await this.getTableColumns(serverId, userId, databaseId, tableName);

    const client = await this.getDatabaseClient(serverId, userId, database.databaseName);

    try {
      const { schema, table } = this.parseTableName(tableName);
      const page = params.page || 1;
      const pageSize = params.pageSize || 100;
      const offset = (page - 1) * pageSize;

      // Build the query with proper SQL injection prevention using escaped identifiers
      const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;

      // Build a set of valid column names for validation
      const validColumnNames = new Set(columns.map((col) => col.name));

      // Build WHERE clause from filters
      let whereClause = "";
      const whereParams: unknown[] = [];
      let paramCounter = 1;

      if (params.filters && params.filters.length > 0) {
        const filterClauses = params.filters.map((filter) => {
          // Validate filter column exists in the table
          if (!validColumnNames.has(filter.column)) {
            throw new Error(`Invalid filter column: ${filter.column}`);
          }
          const columnName = escapeIdentifier(filter.column);

          if (filter.operator === "IS NULL") {
            return `${columnName} IS NULL`;
          } else if (filter.operator === "IS NOT NULL") {
            return `${columnName} IS NOT NULL`;
          } else {
            whereParams.push(filter.value);
            const placeholder = `$${paramCounter++}`;
            return `${columnName} ${filter.operator} ${placeholder}`;
          }
        });

        whereClause = `WHERE ${filterClauses.join(" AND ")}`;
      }

      // Build ORDER BY clause
      let orderByClause = "";
      if (params.sortColumn) {
        // Validate sort column exists in the table
        if (!validColumnNames.has(params.sortColumn)) {
          throw new Error(`Invalid sort column: ${params.sortColumn}`);
        }
        const sortColumn = escapeIdentifier(params.sortColumn);
        const sortDirection = params.sortDirection === "desc" ? "DESC" : "ASC";
        orderByClause = `ORDER BY ${sortColumn} ${sortDirection}`;
      }

      // Get total count
      const countQuery = `SELECT COUNT(*) as total FROM ${fullTableName} ${whereClause}`;
      const countResult = await client.query(countQuery, whereParams);
      const totalRows = parseInt(countResult.rows[0].total, 10);

      // Get paginated data
      const dataQuery = `
        SELECT * FROM ${fullTableName}
        ${whereClause}
        ${orderByClause}
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;
      const dataResult = await client.query(dataQuery, [...whereParams, pageSize, offset]);

      await client.end();

      const totalPages = Math.ceil(totalRows / pageSize);

      logger.info(
        { serverId, databaseId, tableName, page, pageSize, totalRows },
        "Table data retrieved"
      );

      return {
        columns,
        rows: dataResult.rows,
        totalRows,
        page,
        pageSize,
        totalPages,
      };
    } catch (error) {
      await client.end();
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId, databaseId, tableName }, "Failed to get table data");
      throw new Error(`Failed to get table data: ${(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
  }

  /**
   * Get a pg client connected to a specific database on a server
   */
  private async getDatabaseClient(serverId: string, userId: string, databaseName: string): Promise<Client> {
    return await postgresServerService.getClientForDatabase(serverId, userId, databaseName);
  }

  /**
   * Parse table name into schema and table
   * Handles both "schema.table" and "table" formats
   */
  private parseTableName(tableName: string): { schema: string; table: string } {
    const parts = tableName.split(".");
    if (parts.length === 2) {
      return { schema: parts[0], table: parts[1] };
    } else {
      return { schema: "public", table: tableName };
    }
  }
}

// Export singleton instance
const tableDataService = new TableDataService();
export default tableDataService;
