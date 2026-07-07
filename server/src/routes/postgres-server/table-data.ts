import express, { RequestHandler } from "express";
import { z } from "zod";
import { ErrorCode } from "@mini-infra/types";
import { asyncHandler } from "../../lib/async-handler";
import { UnauthorizedError } from "../../lib/errors";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import tableDataService from "../../services/postgres-server/table-data-service";
import { SORT_ORDERS, Permission } from "@mini-infra/types";

const router = express.Router({ mergeParams: true }); // mergeParams to access :serverId and :dbId

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new UnauthorizedError(ErrorCode.USER_NOT_AUTHENTICATED, "User not authenticated");
  }
  return userId;
}

// Validation schemas
const tableDataRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
  sortColumn: z.string().optional(),
  sortDirection: z.enum(SORT_ORDERS).default("asc"),
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
router.get(
  "/",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);

    const tables = await tableDataService.getTableList(serverId, userId, databaseId);

    res.json({
      success: true,
      data: tables,
    });
  }),
);

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId/tables/:tableName/data
 * Get paginated data from a specific table with optional filtering and sorting
 */
router.get(
  "/:tableName/data",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);
    const tableName = String(req.params.tableName);

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
  }),
);

export default router;
