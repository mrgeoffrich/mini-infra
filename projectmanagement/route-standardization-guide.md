# Route Standardization Guide

## Overview

This document outlines standardized patterns for API route development in Mini Infra. After analyzing all existing route files, we've identified key areas where standardization will improve consistency, maintainability, and developer experience.

---

## 1. Error Handling

### Current Issues
- **Inconsistent error propagation**: Some routes use `next(error)`, others return errors directly
- **Mixed Zod error handling**: Some catch `ZodError` separately, some don't
- **Varied error response formats**: Different status codes and response structures
- **Incomplete error context**: Not all routes include `requestId` or useful metadata

### Recommended Standard

#### Use a Centralized Error Response Pattern

```typescript
// Standard error response structure
interface ErrorResponse {
  success: false;
  error: string;          // Error category (e.g., "Validation Error", "Not Found")
  message: string;        // User-friendly message
  details?: any;          // Additional error details (e.g., Zod issues)
  timestamp: string;      // ISO timestamp
  requestId?: string;     // Request ID for tracing
}
```

#### Pattern for Route Handlers

```typescript
router.post("/example", requireSessionOrApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  try {
    // Validate request
    const validationResult = exampleSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        { requestId, userId, validationErrors: validationResult.error.issues },
        "Validation failed"
      );

      return res.status(400).json({
        success: false,
        error: "Validation Error",
        message: "Invalid request data",
        details: validationResult.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Business logic here...

    // Success response
    logger.debug({ requestId, userId }, "Operation completed successfully");

    return res.status(200).json({
      success: true,
      data: result,
      message: "Operation completed successfully",
      timestamp: new Date().toISOString(),
      requestId,
    });

  } catch (error) {
    // Log error with full context
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
        userId,
        body: req.body,
      },
      "Operation failed"
    );

    // Check for known error types
    if (error instanceof Error) {
      // Handle specific known errors
      if (error.message.includes("not found")) {
        return res.status(404).json({
          success: false,
          error: "Not Found",
          message: error.message,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      if (error.message.includes("already exists") || error.message.includes("Unique constraint")) {
        return res.status(409).json({
          success: false,
          error: "Conflict",
          message: error.message,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }
    }

    // Pass to error handler middleware for unknown errors
    next(error);
  }
});
```

#### Common HTTP Status Codes

| Status | Use Case | Example |
|--------|----------|---------|
| 200 | Successful GET, PUT, PATCH | Resource retrieved/updated |
| 201 | Successful POST (creation) | Resource created |
| 202 | Accepted (async processing) | Deployment triggered |
| 204 | Successful DELETE | Resource deleted |
| 400 | Validation error | Invalid request body/params |
| 401 | Authentication required | Missing/invalid auth |
| 403 | Forbidden | Insufficient permissions |
| 404 | Resource not found | Entity doesn't exist |
| 409 | Conflict | Duplicate resource |
| 500 | Internal server error | Unexpected errors (via `next(error)`) |
| 503 | Service unavailable | External service down |
| 504 | Gateway timeout | External service timeout |

---

## 2. Validation

### Current Issues
- **Mixed `.parse()` vs `.safeParse()`**: Inconsistent approach to validation
- **Duplicated validation logic**: Pagination and query params validated differently
- **No reusable validation helpers**: Same patterns repeated across routes

### Recommended Standard

#### Always Use `.safeParse()` for Route-Level Validation

```typescript
// ❌ BAD - Throws exception, requires separate try-catch
const validatedData = exampleSchema.parse(req.body);

// ✅ GOOD - Returns result object, explicit error handling
const validationResult = exampleSchema.safeParse(req.body);
if (!validationResult.success) {
  return res.status(400).json({
    success: false,
    error: "Validation Error",
    message: "Invalid request data",
    details: validationResult.error.issues,
    timestamp: new Date().toISOString(),
    requestId: req.headers["x-request-id"] as string,
  });
}

const validatedData = validationResult.data;
// Use validatedData safely...
```

#### Create Reusable Validation Schemas

```typescript
// lib/validation-schemas.ts

import { z } from "zod";

/**
 * Standard pagination schema for query parameters
 */
export const paginationQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 1;
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Page must be a positive integer",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  limit: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 20;
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Limit must be between 1 and 100",
        });
        return z.NEVER;
      }
      return parsed;
    }),
});

/**
 * Standard sorting schema for query parameters
 */
export const sortingQuerySchema = z.object({
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).optional().default("asc"),
});

/**
 * UUID parameter validation
 */
export const uuidParamSchema = z.string().uuid("Invalid UUID format");

/**
 * CUID parameter validation
 */
export const cuidParamSchema = z.string().cuid("Invalid CUID format");

/**
 * ISO Date string validation with transformation
 */
export const isoDateSchema = z
  .string()
  .optional()
  .transform((val, ctx) => {
    if (!val) return undefined;
    const parsed = new Date(val);
    if (isNaN(parsed.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Must be a valid ISO date string",
      });
      return z.NEVER;
    }
    return parsed;
  });
```

#### Use Schemas in Routes

```typescript
import { paginationQuerySchema, sortingQuerySchema } from "../lib/validation-schemas";

const listQuerySchema = paginationQuerySchema
  .merge(sortingQuerySchema)
  .extend({
    status: z.enum(["active", "inactive"]).optional(),
    name: z.string().optional(),
  });

router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const validationResult = listQuerySchema.safeParse(req.query);

  if (!validationResult.success) {
    return res.status(400).json({
      success: false,
      error: "Validation Error",
      message: "Invalid query parameters",
      details: validationResult.error.issues,
      timestamp: new Date().toISOString(),
      requestId: req.headers["x-request-id"] as string,
    });
  }

  const { page, limit, sortBy, sortOrder, status, name } = validationResult.data;

  // Continue with validated data...
});
```

---

## 3. Pagination

### Current Issues
- **Inconsistent metadata**: Some routes return `hasMore`, others `hasNextPage`/`hasPreviousPage`
- **Different calculation approaches**: No standard helper function
- **Varied response structures**: Pagination metadata in different places

### Recommended Standard

#### Standard Pagination Response Structure

```typescript
interface PaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: {
    page: number;           // Current page (1-indexed)
    limit: number;          // Items per page
    totalCount: number;     // Total items across all pages
    totalPages: number;     // Total number of pages
    hasNextPage: boolean;   // Whether there's a next page
    hasPreviousPage: boolean; // Whether there's a previous page
  };
  message?: string;
  timestamp?: string;
  requestId?: string;
}
```

#### Pagination Helper Function

```typescript
// lib/pagination-helpers.ts

export interface PaginationParams {
  page: number;      // 1-indexed page number
  limit: number;     // Items per page (max 100)
}

export interface PaginationMetadata {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Calculate pagination metadata
 */
export function calculatePagination(
  page: number,
  limit: number,
  totalCount: number
): PaginationMetadata {
  const totalPages = Math.ceil(totalCount / limit);

  return {
    page,
    limit,
    totalCount,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/**
 * Calculate skip/take values for Prisma
 */
export function getPaginationParams(page: number, limit: number) {
  return {
    skip: (page - 1) * limit,
    take: limit,
  };
}
```

#### Example Usage

```typescript
import { paginationQuerySchema } from "../lib/validation-schemas";
import { calculatePagination, getPaginationParams } from "../lib/pagination-helpers";

router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);

  try {
    // Validate pagination params
    const queryValidation = paginationQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      return res.status(400).json({
        success: false,
        error: "Validation Error",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { page, limit } = queryValidation.data;
    const { skip, take } = getPaginationParams(page, limit);

    // Fetch data with pagination
    const [items, totalCount] = await Promise.all([
      prisma.item.findMany({
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.item.count(),
    ]);

    // Calculate pagination metadata
    const pagination = calculatePagination(page, limit, totalCount);

    res.json({
      success: true,
      data: items,
      pagination,
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    logger.error({ error, requestId }, "Failed to fetch items");
    next(error);
  }
});
```

---

## 4. Logging

### Current Issues
- **Inconsistent log levels**: Same operations logged at different levels
- **Missing context**: Not all logs include `requestId`, `userId`
- **Incomplete error logging**: Some errors lack stack traces
- **Sensitive data exposure**: Some logs include full request bodies with secrets

### Recommended Standard

#### Standard Logging Pattern

```typescript
/**
 * Log at operation start (debug level)
 */
logger.debug(
  {
    requestId,
    userId,
    operation: "list_items",
    params: { page, limit, filters },
  },
  "Operation started"
);

/**
 * Log successful operations (debug level)
 */
logger.debug(
  {
    requestId,
    userId,
    operation: "list_items",
    resultCount: items.length,
    duration: Date.now() - startTime,
  },
  "Operation completed successfully"
);

/**
 * Log warnings (warn level)
 */
logger.warn(
  {
    requestId,
    userId,
    validationErrors: validationResult.error.issues,
  },
  "Validation failed"
);

/**
 * Log errors (error level)
 */
logger.error(
  {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    requestId,
    userId,
    operation: "list_items",
    // ❌ Don't log full body if it might contain secrets
    // body: req.body,
    // ✅ Log sanitized version or just metadata
    bodyKeys: Object.keys(req.body),
  },
  "Operation failed"
);

/**
 * Log business events (info level)
 */
logger.info(
  {
    event: "deployment_triggered",
    userId,
    deploymentId: deployment.id,
    applicationName: config.applicationName,
    trigger: "manual",
  },
  "Deployment triggered by user"
);
```

#### Sensitive Data Redaction

```typescript
/**
 * Redact sensitive fields from request body for logging
 */
function sanitizeForLogging(body: any): any {
  const sensitiveFields = [
    "password",
    "apiKey",
    "secret",
    "token",
    "credential",
    "value", // For settings endpoints
  ];

  if (typeof body !== "object" || body === null) {
    return body;
  }

  const sanitized = { ...body };

  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = "[REDACTED]";
    }
  }

  return sanitized;
}

// Usage
logger.debug(
  {
    requestId,
    userId,
    body: sanitizeForLogging(req.body),
  },
  "Create setting requested"
);
```

#### Log Levels Guide

| Level | When to Use | Example |
|-------|-------------|---------|
| `trace` | Extremely detailed debugging | Function entry/exit, detailed flow |
| `debug` | Development debugging, request/response tracking | Operation start/end, result counts |
| `info` | Important business events | User actions, deployments, config changes |
| `warn` | Recoverable issues, validation failures | Invalid input, deprecated usage |
| `error` | Errors requiring attention | Operation failures, external service errors |
| `fatal` | Application-critical errors | Unrecoverable errors causing shutdown |

---

## 5. Response Structure

### Current Issues
- **Inconsistent fields**: Some include `success`, some don't; some include `timestamp`/`requestId`
- **Varied success response formats**: Different structures for similar operations
- **Missing metadata**: Not all responses include helpful context

### Recommended Standard

#### Standard Success Response

```typescript
interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;        // Optional user-friendly message
  timestamp?: string;      // ISO timestamp (recommended for all responses)
  requestId?: string;      // Request ID for tracing (recommended)
}

// Example
{
  "success": true,
  "data": {
    "id": "clx123...",
    "name": "Example Item",
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  "message": "Item created successfully",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "requestId": "req_abc123"
}
```

#### Standard Error Response

```typescript
interface ErrorResponse {
  success: false;
  error: string;           // Error category
  message: string;         // User-friendly message
  details?: any;           // Additional context (e.g., validation errors)
  timestamp: string;       // ISO timestamp
  requestId?: string;      // Request ID for tracing
}

// Example
{
  "success": false,
  "error": "Validation Error",
  "message": "Invalid request data",
  "details": [
    {
      "path": ["name"],
      "message": "Name is required"
    }
  ],
  "timestamp": "2025-01-01T00:00:00.000Z",
  "requestId": "req_abc123"
}
```

#### Standard List Response (with pagination)

```typescript
interface ListResponse<T> {
  success: true;
  data: T[];
  pagination: PaginationMetadata;
  message?: string;
  timestamp?: string;
  requestId?: string;
}
```

#### Response Helper Functions

```typescript
// lib/response-helpers.ts

/**
 * Create a standardized success response
 */
export function successResponse<T>(
  data: T,
  options?: {
    message?: string;
    requestId?: string;
  }
) {
  return {
    success: true as const,
    data,
    message: options?.message,
    timestamp: new Date().toISOString(),
    requestId: options?.requestId,
  };
}

/**
 * Create a standardized error response
 */
export function errorResponse(
  error: string,
  message: string,
  options?: {
    details?: any;
    requestId?: string;
    statusCode?: number;
  }
) {
  return {
    response: {
      success: false as const,
      error,
      message,
      details: options?.details,
      timestamp: new Date().toISOString(),
      requestId: options?.requestId,
    },
    statusCode: options?.statusCode || 500,
  };
}

/**
 * Create a standardized list response with pagination
 */
export function listResponse<T>(
  data: T[],
  pagination: PaginationMetadata,
  options?: {
    message?: string;
    requestId?: string;
  }
) {
  return {
    success: true as const,
    data,
    pagination,
    message: options?.message,
    timestamp: new Date().toISOString(),
    requestId: options?.requestId,
  };
}
```

#### Example Usage

```typescript
import { successResponse, errorResponse, listResponse } from "../lib/response-helpers";
import { calculatePagination } from "../lib/pagination-helpers";

router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  const requestId = req.headers["x-request-id"] as string;

  try {
    const item = await createItem(req.body);

    res.status(201).json(
      successResponse(item, {
        message: "Item created successfully",
        requestId,
      })
    );
  } catch (error) {
    logger.error({ error, requestId }, "Failed to create item");
    next(error);
  }
});

router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const requestId = req.headers["x-request-id"] as string;

  try {
    const { page, limit } = parseQueryParams(req.query);
    const [items, totalCount] = await fetchItems(page, limit);
    const pagination = calculatePagination(page, limit, totalCount);

    res.json(
      listResponse(items, pagination, {
        message: `Found ${totalCount} items`,
        requestId,
      })
    );
  } catch (error) {
    logger.error({ error, requestId }, "Failed to fetch items");
    next(error);
  }
});
```

---

## 6. Authentication & Authorization

### Current Issues
- **Inconsistent user retrieval**: Mix of `getAuthenticatedUser(req)`, `getCurrentUserId(req)`, `req.user`
- **Inconsistent auth checks**: Some routes check if user exists, some don't
- **No standard ownership verification**: Different patterns for checking resource ownership

### Recommended Standard

#### Always Use Centralized Middleware Functions

```typescript
import {
  requireSessionOrApiKey,
  getAuthenticatedUser,
  getCurrentUserId,
  requireAuth
} from "../middleware/auth";

// ✅ GOOD - Use helper functions
const user = getAuthenticatedUser(req);
const userId = getCurrentUserId(req);

// ❌ BAD - Direct access to req.user
const user = req.user as JWTUser;
```

#### Standard Pattern for Routes Requiring User

```typescript
router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);

  // For operations that require a user (not API key)
  if (!user?.id) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "User authentication required",
      timestamp: new Date().toISOString(),
      requestId,
    });
  }

  const userId = user.id;

  try {
    // Use userId in business logic...
  } catch (error) {
    logger.error({ error, requestId, userId }, "Operation failed");
    next(error);
  }
});
```

#### Ownership Verification Pattern

```typescript
/**
 * Verify that the authenticated user owns the resource
 */
async function verifyResourceOwnership(
  resourceId: string,
  userId: string,
  resourceType: string
): Promise<boolean> {
  const resource = await prisma[resourceType].findUnique({
    where: { id: resourceId },
    select: { userId: true },
  });

  return resource?.userId === userId;
}

// Usage in route
router.delete("/:id", requireSessionOrApiKey, async (req, res, next) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const itemId = req.params.id;

  try {
    // Verify ownership
    const isOwner = await verifyResourceOwnership(itemId, userId!, "item");

    if (!isOwner) {
      return res.status(403).json({
        success: false,
        error: "Forbidden",
        message: "You don't have permission to delete this resource",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Proceed with deletion...
  } catch (error) {
    logger.error({ error, requestId, userId, itemId }, "Failed to delete item");
    next(error);
  }
});
```

---

## 7. Request Context

### Current Issues
- **Inconsistent requestId extraction**: Some use `req.headers["x-request-id"]`, some use `res.locals.requestId`
- **No standard context object**: requestId, userId scattered throughout handler
- **Repeated code**: Same context extraction in every handler

### Recommended Standard

#### Create Request Context Type

```typescript
// lib/request-context.ts

export interface RequestContext {
  requestId: string;
  userId?: string;
  timestamp: Date;
}

/**
 * Extract standard request context from Express request
 */
export function getRequestContext(req: Request): RequestContext {
  const user = getAuthenticatedUser(req);

  return {
    requestId: req.headers["x-request-id"] as string,
    userId: user?.id,
    timestamp: new Date(),
  };
}
```

#### Use in Route Handlers

```typescript
import { getRequestContext } from "../lib/request-context";

router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  logger.debug(
    {
      requestId: ctx.requestId,
      userId: ctx.userId,
      operation: "create_item",
    },
    "Operation started"
  );

  try {
    const item = await createItem(req.body, ctx.userId);

    logger.debug(
      {
        requestId: ctx.requestId,
        userId: ctx.userId,
        itemId: item.id,
      },
      "Item created successfully"
    );

    res.status(201).json({
      success: true,
      data: item,
      message: "Item created successfully",
      timestamp: ctx.timestamp.toISOString(),
      requestId: ctx.requestId,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        requestId: ctx.requestId,
        userId: ctx.userId,
      },
      "Failed to create item"
    );
    next(error);
  }
});
```

---

## 8. Date Serialization

### Current Issues
- **Inconsistent serialization**: Some manually convert dates, some don't
- **Missing helper functions**: Duplicated serialization logic
- **Timezone handling**: No standard approach

### Recommended Standard

#### Create Serialization Helpers

```typescript
// lib/serialization-helpers.ts

/**
 * Serialize a Date object to ISO string, handling null/undefined
 */
export function serializeDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  return date instanceof Date ? date.toISOString() : null;
}

/**
 * Generic serializer for database models with date fields
 */
export function serializeDates<T extends Record<string, any>>(
  obj: T,
  dateFields: (keyof T)[]
): T {
  const serialized = { ...obj };

  for (const field of dateFields) {
    if (field in serialized) {
      serialized[field] = serializeDate(serialized[field] as any) as any;
    }
  }

  return serialized;
}
```

#### Example Usage

```typescript
import { serializeDate, serializeDates } from "../lib/serialization-helpers";

// Manual serialization for specific fields
function serializeItem(item: Item): ItemInfo {
  return {
    ...item,
    createdAt: serializeDate(item.createdAt)!,
    updatedAt: serializeDate(item.updatedAt)!,
    deletedAt: serializeDate(item.deletedAt),
  };
}

// Automatic serialization with helper
function serializeItemAuto(item: Item): ItemInfo {
  return serializeDates(item, ["createdAt", "updatedAt", "deletedAt"]);
}

// Usage in route
router.get("/:id", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  try {
    const item = await prisma.item.findUnique({
      where: { id: req.params.id },
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        error: "Not Found",
        message: "Item not found",
        timestamp: ctx.timestamp.toISOString(),
        requestId: ctx.requestId,
      });
    }

    res.json({
      success: true,
      data: serializeItem(item),
      timestamp: ctx.timestamp.toISOString(),
      requestId: ctx.requestId,
    });
  } catch (error) {
    logger.error({ error, requestId: ctx.requestId }, "Failed to fetch item");
    next(error);
  }
});
```

---

## 9. Complete Example: Standardized Route File

Here's a complete example demonstrating all standards:

```typescript
import express, { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import { getRequestContext } from "../lib/request-context";
import { paginationQuerySchema, sortingQuerySchema } from "../lib/validation-schemas";
import { calculatePagination, getPaginationParams } from "../lib/pagination-helpers";
import { successResponse, errorResponse, listResponse } from "../lib/response-helpers";
import { serializeDate } from "../lib/serialization-helpers";
import prisma from "../lib/prisma";

const logger = appLogger();
const router = express.Router();

// ====================
// Validation Schemas
// ====================

const createItemSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});

const updateItemSchema = createItemSchema.partial();

const listQuerySchema = paginationQuerySchema
  .merge(sortingQuerySchema)
  .extend({
    isActive: z
      .string()
      .optional()
      .transform((val) => val === "true" ? true : val === "false" ? false : undefined),
    name: z.string().optional(),
  });

// ====================
// Serialization Helpers
// ====================

function serializeItem(item: any) {
  return {
    ...item,
    createdAt: serializeDate(item.createdAt)!,
    updatedAt: serializeDate(item.updatedAt)!,
  };
}

// ====================
// Routes
// ====================

/**
 * GET /api/items - List all items with pagination
 */
router.get(
  "/",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getRequestContext(req);

    logger.debug(
      {
        requestId: ctx.requestId,
        userId: ctx.userId,
        query: req.query,
      },
      "List items requested"
    );

    try {
      // Validate query parameters
      const queryValidation = listQuerySchema.safeParse(req.query);
      if (!queryValidation.success) {
        logger.warn(
          {
            requestId: ctx.requestId,
            userId: ctx.userId,
            validationErrors: queryValidation.error.issues,
          },
          "Invalid query parameters"
        );

        return res.status(400).json({
          success: false,
          error: "Validation Error",
          message: "Invalid query parameters",
          details: queryValidation.error.issues,
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      const { page, limit, sortBy, sortOrder, isActive, name } = queryValidation.data;
      const { skip, take } = getPaginationParams(page, limit);

      // Build where clause
      const where: any = {};
      if (typeof isActive === "boolean") where.isActive = isActive;
      if (name) where.name = { contains: name, mode: "insensitive" };

      // Fetch items with pagination
      const [items, totalCount] = await Promise.all([
        prisma.item.findMany({
          where,
          orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.item.count({ where }),
      ]);

      const serializedItems = items.map(serializeItem);
      const pagination = calculatePagination(page, limit, totalCount);

      logger.debug(
        {
          requestId: ctx.requestId,
          userId: ctx.userId,
          totalItems: totalCount,
          returnedItems: serializedItems.length,
        },
        "List items returned successfully"
      );

      res.json(
        listResponse(serializedItems, pagination, {
          message: `Found ${totalCount} items`,
          requestId: ctx.requestId,
        })
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          requestId: ctx.requestId,
          userId: ctx.userId,
        },
        "Failed to list items"
      );

      next(error);
    }
  }
);

/**
 * POST /api/items - Create a new item
 */
router.post(
  "/",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getRequestContext(req);

    logger.debug(
      {
        requestId: ctx.requestId,
        userId: ctx.userId,
      },
      "Create item requested"
    );

    try {
      // Require authenticated user
      if (!ctx.userId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          message: "User authentication required",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      // Validate request body
      const bodyValidation = createItemSchema.safeParse(req.body);
      if (!bodyValidation.success) {
        logger.warn(
          {
            requestId: ctx.requestId,
            userId: ctx.userId,
            validationErrors: bodyValidation.error.issues,
          },
          "Invalid request body"
        );

        return res.status(400).json({
          success: false,
          error: "Validation Error",
          message: "Invalid request data",
          details: bodyValidation.error.issues,
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      const validatedData = bodyValidation.data;

      // Create item
      const item = await prisma.item.create({
        data: {
          ...validatedData,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      });

      logger.debug(
        {
          requestId: ctx.requestId,
          userId: ctx.userId,
          itemId: item.id,
        },
        "Item created successfully"
      );

      res.status(201).json(
        successResponse(serializeItem(item), {
          message: "Item created successfully",
          requestId: ctx.requestId,
        })
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          requestId: ctx.requestId,
          userId: ctx.userId,
        },
        "Failed to create item"
      );

      // Check for known errors
      if (error instanceof Error && error.message.includes("Unique constraint")) {
        return res.status(409).json({
          success: false,
          error: "Conflict",
          message: "An item with this name already exists",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      next(error);
    }
  }
);

/**
 * GET /api/items/:id - Get a specific item
 */
router.get(
  "/:id",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getRequestContext(req);
    const itemId = req.params.id;

    logger.debug(
      {
        requestId: ctx.requestId,
        userId: ctx.userId,
        itemId,
      },
      "Get item requested"
    );

    try {
      // Validate item ID format
      if (!itemId || itemId.length < 8) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          message: "Invalid item ID format",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      // Fetch item
      const item = await prisma.item.findUnique({
        where: { id: itemId },
      });

      if (!item) {
        logger.warn(
          {
            requestId: ctx.requestId,
            userId: ctx.userId,
            itemId,
          },
          "Item not found"
        );

        return res.status(404).json({
          success: false,
          error: "Not Found",
          message: `Item with ID '${itemId}' not found`,
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      logger.debug(
        {
          requestId: ctx.requestId,
          userId: ctx.userId,
          itemId,
        },
        "Item retrieved successfully"
      );

      res.json(
        successResponse(serializeItem(item), {
          requestId: ctx.requestId,
        })
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          requestId: ctx.requestId,
          userId: ctx.userId,
          itemId,
        },
        "Failed to get item"
      );

      next(error);
    }
  }
);

/**
 * PUT /api/items/:id - Update an item
 */
router.put(
  "/:id",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getRequestContext(req);
    const itemId = req.params.id;

    logger.debug(
      {
        requestId: ctx.requestId,
        userId: ctx.userId,
        itemId,
      },
      "Update item requested"
    );

    try {
      // Require authenticated user
      if (!ctx.userId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          message: "User authentication required",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      // Validate item ID format
      if (!itemId || itemId.length < 8) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          message: "Invalid item ID format",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      // Validate request body
      const bodyValidation = updateItemSchema.safeParse(req.body);
      if (!bodyValidation.success) {
        logger.warn(
          {
            requestId: ctx.requestId,
            userId: ctx.userId,
            itemId,
            validationErrors: bodyValidation.error.issues,
          },
          "Invalid request body"
        );

        return res.status(400).json({
          success: false,
          error: "Validation Error",
          message: "Invalid request data",
          details: bodyValidation.error.issues,
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      const validatedData = bodyValidation.data;

      // Update item
      const item = await prisma.item.update({
        where: { id: itemId },
        data: {
          ...validatedData,
          updatedBy: ctx.userId,
        },
      });

      logger.debug(
        {
          requestId: ctx.requestId,
          userId: ctx.userId,
          itemId,
        },
        "Item updated successfully"
      );

      res.json(
        successResponse(serializeItem(item), {
          message: "Item updated successfully",
          requestId: ctx.requestId,
        })
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          requestId: ctx.requestId,
          userId: ctx.userId,
          itemId,
        },
        "Failed to update item"
      );

      // Check for known errors
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({
          success: false,
          error: "Not Found",
          message: `Item with ID '${itemId}' not found`,
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      if (error instanceof Error && error.message.includes("Unique constraint")) {
        return res.status(409).json({
          success: false,
          error: "Conflict",
          message: "An item with this name already exists",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      next(error);
    }
  }
);

/**
 * DELETE /api/items/:id - Delete an item
 */
router.delete(
  "/:id",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getRequestContext(req);
    const itemId = req.params.id;

    logger.debug(
      {
        requestId: ctx.requestId,
        userId: ctx.userId,
        itemId,
      },
      "Delete item requested"
    );

    try {
      // Require authenticated user
      if (!ctx.userId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          message: "User authentication required",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      // Validate item ID format
      if (!itemId || itemId.length < 8) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          message: "Invalid item ID format",
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      // Delete item
      await prisma.item.delete({
        where: { id: itemId },
      });

      logger.debug(
        {
          requestId: ctx.requestId,
          userId: ctx.userId,
          itemId,
        },
        "Item deleted successfully"
      );

      res.status(204).send();
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          requestId: ctx.requestId,
          userId: ctx.userId,
          itemId,
        },
        "Failed to delete item"
      );

      // Check for known errors
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({
          success: false,
          error: "Not Found",
          message: `Item with ID '${itemId}' not found`,
          timestamp: ctx.timestamp.toISOString(),
          requestId: ctx.requestId,
        });
      }

      next(error);
    }
  }
);

export default router;
```

---

## 10. Other Standardization Opportunities

### TypeScript Request Handler Casting

**Current Issue**: Inconsistent use of `as RequestHandler`

**Standard**: Always cast async route handlers to `RequestHandler`

```typescript
// ✅ GOOD
router.get(
  "/",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response, next: NextFunction) => {
    // Handler code...
  }
);

// ❌ BAD - No casting (causes TypeScript errors in some cases)
router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  // Handler code...
});
```

### Route File Structure

**Standard layout for route files**:

```typescript
// 1. Imports
import express from "express";
import { z } from "zod";
// ... other imports

// 2. Logger initialization
const logger = appLogger();
const router = express.Router();

// 3. Validation schemas section
// ====================
// Validation Schemas
// ====================

// 4. Helper functions section
// ====================
// Helper Functions
// ====================

// 5. Routes section
// ====================
// Routes
// ====================

// 6. Export
export default router;
```

### Comment Documentation

**Standard**: Add JSDoc comments for all route handlers

```typescript
/**
 * GET /api/items/:id
 *
 * Retrieves a specific item by ID.
 *
 * @param id - The item ID (path parameter)
 * @returns ItemInfo - The item details
 *
 * @throws 400 - Invalid item ID format
 * @throws 404 - Item not found
 * @throws 500 - Internal server error
 */
router.get("/:id", requireSessionOrApiKey, async (req, res, next) => {
  // Handler code...
});
```

---

## Summary of Changes Required

### High Priority
1. ✅ **Error handling**: Standardize on `next(error)` pattern for unknown errors
2. ✅ **Validation**: Always use `.safeParse()`, create reusable schemas
3. ✅ **Response structure**: Include `success`, `timestamp`, `requestId` consistently
4. ✅ **Logging**: Include `requestId`, `userId` in all logs, use appropriate levels

### Medium Priority
5. ✅ **Pagination**: Use standard helper functions and metadata structure
6. ✅ **Request context**: Use `getRequestContext()` helper
7. ✅ **Date serialization**: Use serialization helpers

### Low Priority
8. ✅ **Route file structure**: Consistent section organization
9. ✅ **Documentation**: Add JSDoc comments to all routes
10. ✅ **TypeScript**: Consistent `RequestHandler` casting

---

## Migration Strategy

### Phase 1: Create Utility Libraries (Week 1)
- Create `lib/validation-schemas.ts`
- Create `lib/pagination-helpers.ts`
- Create `lib/response-helpers.ts`
- Create `lib/request-context.ts`
- Create `lib/serialization-helpers.ts`

### Phase 2: Update High-Traffic Routes (Week 2-3)
- Update `containers.ts`
- Update `deployments.ts`
- Update `environments.ts`

### Phase 3: Update Remaining Routes (Week 4-5)
- Update all other route files systematically
- Ensure consistency across the board

### Phase 4: Documentation & Review (Week 6)
- Update CLAUDE.md with new patterns
- Code review all changes
- Update tests to match new patterns

---

## Questions for Discussion

1. Should we create a global error handler middleware to catch all errors?
2. Do we want to enforce these standards via ESLint rules or code review?
3. Should `requestId` and `timestamp` be required in all responses, or optional?
4. Should we create a code generator or template for new routes?
5. How do we handle backwards compatibility with existing API clients?
