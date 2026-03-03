import express from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import tableDataService from "../../services/postgres-server/table-data-service";

const logger = appLogger();
const router = express.Router({ mergeParams: true }); // mergeParams to access :serverId and :dbId

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new Error("Unauthorized");
  }
  return userId;
}

// Validation schemas
const tableDataRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
  sortColumn: z.string().optional(),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  filters: z.array(z.object({
    column: z.string(),
    operator: z.enum(["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })).optional(),
});

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId/tables
 * List all tables in the database with metadata
 */
router.get("/", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;
    const databaseId = req.params.dbId;

    const tables = await tableDataService.getTableList(serverId, userId, databaseId);

    res.json({
      success: true,
      data: tables,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if (error.message === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: error.message, serverId: req.params.serverId, databaseId: req.params.dbId },
      "Failed to list tables");
    res.status(500).json({
      success: false,
      error: "Failed to list tables",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId/tables/:tableName/data
 * Get paginated data from a specific table with optional filtering and sorting
 */
router.get("/:tableName/data", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;
    const databaseId = req.params.dbId;
    const tableName = req.params.tableName;

    // Validate and parse query parameters
    const validatedParams = tableDataRequestSchema.parse({
      page: req.query.page,
      pageSize: req.query.pageSize,
      sortColumn: req.query.sortColumn,
      sortDirection: req.query.sortDirection,
      filters: req.query.filters ? JSON.parse(req.query.filters as string) : undefined,
    });

    const tableData = await tableDataService.getTableData(
      serverId,
      userId,
      databaseId,
      tableName,
      validatedParams
    );

    res.json({
      success: true,
      data: tableData,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if (error.message === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    if (error.message === "Table not found") {
      return res.status(404).json({
        success: false,
        error: "Table not found",
      });
    }

    logger.error(
      {
        error: error.message,
        serverId: req.params.serverId,
        databaseId: req.params.dbId,
        tableName: req.params.tableName
      },
      "Failed to get table data"
    );
    res.status(500).json({
      success: false,
      error: "Failed to get table data",
      message: error.message,
    });
  }
});

export default router;
