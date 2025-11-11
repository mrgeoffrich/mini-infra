# Route Standardization Implementation Plan

## Overview

This plan outlines the implementation of standardized route patterns across the Mini Infra application. Based on the Route Standardization Guide, we'll implement helper libraries, middleware, and documentation to ensure consistency.

---

## Phase 1: Foundation - Core Infrastructure (Week 1)

### 1.0 Shared Types - Frontend/Backend Consistency

**Goal**: Ensure request/response types are identical between frontend and backend to prevent type mismatches

#### Update Shared Types Package (`lib/types/api.ts`)

The `@mini-infra/types` package already exists but needs to be updated with standardized response types:

**Key Changes**:
1. **Make `timestamp` and `requestId` required** in `ResponseMetadata`
2. **Add proper generic types** for `SuccessResponse<T>`, `ListResponse<T>`, `ErrorResponse`
3. **Add type guards** for discriminated unions (e.g., `isSuccessResponse()`, `isErrorResponse()`)
4. **Add `PaginationMetadata`** with all required fields
5. **Add validation error types** with structured details

**Benefits**:
- ✅ **Single source of truth** for API contracts
- ✅ **Compile-time safety** - Frontend and backend must agree on types
- ✅ **Autocomplete** in both frontend (axios/fetch) and backend (route handlers)
- ✅ **Type guards** for safe runtime type checking on frontend
- ✅ **Refactoring safety** - Changing a type updates both sides

**Updated file**: `lib/types/api.ts`

```typescript
// Base metadata REQUIRED on ALL responses
export interface ResponseMetadata {
  timestamp: string;      // ISO 8601 - REQUIRED
  requestId: string;      // Request ID - REQUIRED
}

// Success response with single resource
export interface SuccessResponse<T> extends ResponseMetadata {
  success: true;
  data: T;
  message?: string;
}

// Success response with paginated list
export interface ListResponse<T> extends ResponseMetadata {
  success: true;
  data: T[];
  pagination: PaginationMetadata;
  message?: string;
}

// Standard error response
export interface ErrorResponse extends ResponseMetadata {
  success: false;
  error: string;
  message: string;
  details?: any;
}

// Pagination metadata (standardized)
export interface PaginationMetadata {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// Type guards for frontend
export function isSuccessResponse<T>(
  response: ApiResponse<T>
): response is SuccessResponse<T> {
  return response.success === true;
}

export function isErrorResponse<T>(
  response: ApiResponse<T>
): response is ErrorResponse {
  return response.success === false;
}
```

#### Usage Examples

**Backend (route handler)**:
```typescript
import { SuccessResponse, ListResponse, PaginationMetadata } from "@mini-infra/types";

// Backend knows the exact shape
const response: SuccessResponse<Item> = {
  success: true,
  data: item,
  timestamp: new Date().toISOString(),
  requestId: ctx.requestId,
};
```

**Frontend (React Query / Axios)**:
```typescript
import { SuccessResponse, isSuccessResponse, ItemInfo } from "@mini-infra/types";

// Frontend knows the exact shape
const response = await axios.get<SuccessResponse<ItemInfo>>("/api/items/123");

// Type guard for discriminated union
if (isSuccessResponse(response.data)) {
  // TypeScript knows this is SuccessResponse<ItemInfo>
  console.log(response.data.data.name); // ✅ Type-safe
  console.log(response.data.requestId); // ✅ Always present
} else {
  // TypeScript knows this is ErrorResponse
  console.error(response.data.message); // ✅ Type-safe
}
```

#### Build Process

The shared types must be built before client/server:

```bash
# Build order (already configured in package.json)
npm run build:lib    # First - build shared types
npm run build:server # Second - server imports from lib
npm run build:client # Third - client imports from lib
```

#### Benefits Over Ad-Hoc Types

**Before (inconsistent)**:
```typescript
// Backend
res.json({ success: true, data: item, time: Date.now() }); // ❌ 'time' not 'timestamp'

// Frontend
interface BackendResponse { success: boolean; data: any; time: number; } // ❌ Must match manually
```

**After (shared types)**:
```typescript
// Backend
const response: SuccessResponse<Item> = { /* ✅ Must include timestamp, requestId */ };

// Frontend
const response: SuccessResponse<Item> = await api.get(...); // ✅ Same type!
```

---

### 1.1 Response Base System

**Goal**: Ensure ALL responses have `requestId` and `timestamp`

#### Create Response Middleware
**File**: `server/src/middleware/response-context.ts`

```typescript
import { Request, Response, NextFunction } from "express";
import {
  SuccessResponse,
  ListResponse,
  ErrorResponse,
  PaginationMetadata
} from "@mini-infra/types";

/**
 * Middleware to add response context helpers
 * Adds requestId and timestamp to all responses
 * Uses shared types from @mini-infra/types for frontend/backend consistency
 */
export function responseContext(req: Request, res: Response, next: NextFunction) {
  const requestId = req.headers["x-request-id"] as string;
  const timestamp = new Date().toISOString();

  // Store context in res.locals for access in route handlers
  res.locals.requestId = requestId;
  res.locals.timestamp = timestamp;

  // Add helper methods to response object
  res.success = function<T>(data: T, options?: { message?: string; statusCode?: number }): Response {
    const response: SuccessResponse<T> = {
      success: true,
      data,
      message: options?.message,
      timestamp,
      requestId,
    };
    return this.status(options?.statusCode || 200).json(response);
  };

  res.error = function(error: string, message: string, options?: { details?: any; statusCode?: number }): Response {
    const response: ErrorResponse = {
      success: false,
      error,
      message,
      details: options?.details,
      timestamp,
      requestId,
    };
    return this.status(options?.statusCode || 500).json(response);
  };

  res.list = function<T>(data: T[], pagination: PaginationMetadata, options?: { message?: string }): Response {
    const response: ListResponse<T> = {
      success: true,
      data,
      pagination,
      message: options?.message,
      timestamp,
      requestId,
    };
    return this.status(200).json(response);
  };

  next();
}

// Extend Express Response type
declare global {
  namespace Express {
    interface Response {
      success<T>(data: T, options?: { message?: string; statusCode?: number }): Response;
      error(error: string, message: string, options?: { details?: any; statusCode?: number }): Response;
      list<T>(data: T[], pagination: PaginationMetadata, options?: { message?: string }): Response;
    }
  }
}
```

**Register in app.ts**:
```typescript
import { responseContext } from "./middleware/response-context";

// After other middleware, before routes
app.use(responseContext);
```

#### Benefits
- ✅ Guarantees `requestId` and `timestamp` on ALL responses
- ✅ Clean, consistent API: `res.success()`, `res.error()`, `res.list()`
- ✅ Reduces boilerplate in route handlers
- ✅ TypeScript-safe with type extensions

---

### 1.2 Global Error Handler Middleware

**File**: `server/src/middleware/global-error-handler.ts`

```typescript
import { Request, Response, NextFunction } from "express";
import { appLogger } from "../lib/logger-factory";
import { Prisma } from "@prisma/client";

const logger = appLogger();

/**
 * Global error handler middleware
 * Catches all errors not handled by route handlers
 */
export function globalErrorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = res.locals.requestId || (req.headers["x-request-id"] as string);
  const timestamp = res.locals.timestamp || new Date().toISOString();

  // Log the error with full context
  logger.error(
    {
      error: error.message,
      stack: error.stack,
      requestId,
      userId: res.locals.userId,
      path: req.path,
      method: req.method,
      body: sanitizeForLogging(req.body),
      query: req.query,
      params: req.params,
    },
    "Unhandled error in route handler"
  );

  // Check if response has already been sent
  if (res.headersSent) {
    return next(error);
  }

  // Handle known error types

  // Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      // Unique constraint violation
      return res.status(409).json({
        success: false,
        error: "Conflict",
        message: "A record with this information already exists",
        details: { field: (error.meta?.target as string[])?.join(", ") },
        timestamp,
        requestId,
      });
    }

    if (error.code === "P2025") {
      // Record not found
      return res.status(404).json({
        success: false,
        error: "Not Found",
        message: "The requested resource was not found",
        timestamp,
        requestId,
      });
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({
      success: false,
      error: "Validation Error",
      message: "Invalid data provided",
      timestamp,
      requestId,
    });
  }

  // Zod validation errors (shouldn't reach here, but just in case)
  if (error.name === "ZodError") {
    return res.status(400).json({
      success: false,
      error: "Validation Error",
      message: "Invalid request data",
      details: (error as any).issues,
      timestamp,
      requestId,
    });
  }

  // Generic error response
  return res.status(500).json({
    success: false,
    error: "Internal Server Error",
    message: process.env.NODE_ENV === "production"
      ? "An unexpected error occurred"
      : error.message,
    timestamp,
    requestId,
  });
}

/**
 * Sanitize request body for logging (remove sensitive fields)
 */
function sanitizeForLogging(body: any): any {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const sensitiveFields = [
    "password",
    "apiKey",
    "secret",
    "token",
    "credential",
    "value", // For settings endpoints
  ];

  const sanitized = { ...body };

  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = "[REDACTED]";
    }
  }

  return sanitized;
}
```

**Register in app.ts**:
```typescript
import { globalErrorHandler } from "./middleware/global-error-handler";

// MUST be registered AFTER all routes
app.use(globalErrorHandler);
```

---

### 1.3 Helper Libraries

#### File: `server/src/lib/validation-schemas.ts`

```typescript
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

/**
 * Boolean query parameter transformation
 */
export const booleanQuerySchema = z
  .string()
  .optional()
  .transform((val) => {
    if (!val) return undefined;
    return val.toLowerCase() === "true";
  });
```

#### File: `server/src/lib/pagination-helpers.ts`

```typescript
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

#### File: `server/src/lib/request-context.ts`

```typescript
import { Request } from "express";
import { getAuthenticatedUser } from "../middleware/auth";

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

#### File: `server/src/lib/serialization-helpers.ts`

```typescript
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

---

### 1.4 Update app.ts

**Register middleware in correct order**:

```typescript
// server/src/app.ts

import { responseContext } from "./middleware/response-context";
import { globalErrorHandler } from "./middleware/global-error-handler";

// ... existing middleware (cors, helmet, etc.)

// Add response context BEFORE routes
app.use(responseContext);

// ... existing routes registration

// Add global error handler AFTER all routes (MUST BE LAST)
app.use(globalErrorHandler);
```

---

### 1.5 Deliverables

- [ ] **`lib/types/api.ts`** - Update shared types for frontend/backend consistency (FIRST - required by all)
- [ ] **`lib/` package build** - Build shared types package (`npm run build:lib`)
- [ ] `middleware/response-context.ts` - Response helper middleware
- [ ] `middleware/global-error-handler.ts` - Global error handler
- [ ] `lib/validation-schemas.ts` - Reusable Zod schemas
- [ ] `lib/pagination-helpers.ts` - Pagination utilities
- [ ] `lib/request-context.ts` - Request context extraction
- [ ] `lib/serialization-helpers.ts` - Date serialization
- [ ] Update `app.ts` to register new middleware
- [ ] Update response middleware to use shared types from `@mini-infra/types`

---

## Phase 2: Pilot Implementation - High-Traffic Routes (Week 2)

### 2.1 Convert High-Traffic Routes

**Priority order**:
1. `containers.ts` - Most frequently accessed
2. `deployments.ts` - Complex, mission-critical
3. `api-keys.ts` - Simple, good learning example

### 2.2 Pattern for Each Route Conversion

#### Before:
```typescript
router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);

  try {
    const items = await fetchItems();

    res.json({
      success: true,
      data: items,
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    logger.error({ error, requestId }, "Failed to fetch items");
    next(error);
  }
});
```

#### After:
```typescript
import { paginationQuerySchema } from "../lib/validation-schemas";
import { calculatePagination, getPaginationParams } from "../lib/pagination-helpers";
import { getRequestContext } from "../lib/request-context";

router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  logger.debug({ requestId: ctx.requestId, userId: ctx.userId }, "List items requested");

  try {
    // Validate with safeParse
    const queryValidation = paginationQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        { requestId: ctx.requestId, validationErrors: queryValidation.error.issues },
        "Validation failed"
      );

      return res.error("Validation Error", "Invalid query parameters", {
        details: queryValidation.error.issues,
        statusCode: 400,
      });
    }

    const { page, limit } = queryValidation.data;
    const { skip, take } = getPaginationParams(page, limit);

    const [items, totalCount] = await Promise.all([
      prisma.item.findMany({ skip, take }),
      prisma.item.count(),
    ]);

    const pagination = calculatePagination(page, limit, totalCount);

    logger.debug(
      { requestId: ctx.requestId, totalCount, returnedCount: items.length },
      "Items fetched successfully"
    );

    // Use response helper
    return res.list(items, pagination, { message: `Found ${totalCount} items` });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), requestId: ctx.requestId },
      "Failed to fetch items"
    );

    // Let global error handler deal with it
    next(error);
  }
});
```

### 2.3 Deliverables

- [ ] Convert `containers.ts` to new patterns
- [ ] Convert `deployments.ts` to new patterns
- [ ] Convert `api-keys.ts` to new patterns
- [ ] Document any issues/learnings in conversion log
- [ ] Update tests for converted routes

---

## Phase 3: Batch Conversion - Remaining Routes (Week 3-4)

### 3.1 Route Conversion Groups

**Week 3 - Group A: Configuration Routes**
- [ ] `environments.ts`
- [ ] `environment-networks.ts`
- [ ] `environment-volumes.ts`
- [ ] `settings.ts`
- [ ] `system-settings.ts`
- [ ] `deployment-infrastructure.ts`
- [ ] `registry-credentials.ts`

**Week 4 - Group B: Service Routes**
- [ ] `postgres-databases.ts`
- [ ] `postgres-backups.ts`
- [ ] `postgres-backup-configs.ts`
- [ ] `postgres-restore.ts`
- [ ] `postgres-progress.ts`
- [ ] `tls-certificates.ts`
- [ ] `tls-settings.ts`
- [ ] `tls-renewals.ts`

**Week 4 - Group C: Integration Routes**
- [ ] `azure-settings.ts`
- [ ] `azure-connectivity.ts`
- [ ] `cloudflare-settings.ts`
- [ ] `cloudflare-connectivity.ts`
- [ ] `haproxy-frontends.ts`
- [ ] `manual-haproxy-frontends.ts`
- [ ] `deployment-dns.ts`

**Week 4 - Group D: Remaining Routes**
- [ ] `auth.ts` (special case - different patterns)
- [ ] `user-preferences.ts`
- [ ] `settings-self-backup.ts`
- [ ] `self-backups.ts`

### 3.2 Quality Gates

For each route file conversion:
1. ✅ All handlers use `.safeParse()` for validation
2. ✅ All responses use `res.success()`, `res.error()`, or `res.list()`
3. ✅ All errors pass through `next(error)` to global handler
4. ✅ All logs include `requestId` and `userId`
5. ✅ Pagination uses helper functions
6. ✅ Request context uses `getRequestContext()`
7. ✅ No direct response construction (use middleware helpers)
8. ✅ Tests updated and passing

---

## Phase 4: Documentation & Developer Guide (Week 5)

### 4.1 Create Developer Guide

**File**: `.claude/guides/how-to-write-routes.md`

This guide will be the authoritative reference for all future route development.

#### Guide Structure

```markdown
# How to Write API Routes in Mini Infra

## Quick Reference

### Minimal Route Example

\`\`\`typescript
import express from "express";
import { requireSessionOrApiKey } from "../middleware/auth";
import { getRequestContext } from "../lib/request-context";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
const router = express.Router();

router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  try {
    const data = await fetchData();
    return res.success(data);
  } catch (error) {
    logger.error({ error, requestId: ctx.requestId }, "Operation failed");
    next(error);
  }
});

export default router;
\`\`\`

## Table of Contents
1. File Structure
2. Validation
3. Responses
4. Error Handling
5. Logging
6. Pagination
7. Authentication
8. Complete Examples

## 1. File Structure

Every route file should follow this structure:

\`\`\`typescript
// 1. Imports
import express from "express";
import { z } from "zod";
import { requireSessionOrApiKey } from "../middleware/auth";
import { getRequestContext } from "../lib/request-context";
import { paginationQuerySchema } from "../lib/validation-schemas";
import { calculatePagination, getPaginationParams } from "../lib/pagination-helpers";
import { appLogger } from "../lib/logger-factory";
import prisma from "../lib/prisma";

// 2. Logger & Router initialization
const logger = appLogger();
const router = express.Router();

// 3. Validation Schemas
const createItemSchema = z.object({
  name: z.string().min(1),
});

// 4. Helper Functions (serialization, etc.)
function serializeItem(item: any) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
  };
}

// 5. Route Handlers
router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  // Handler code
});

// 6. Export
export default router;
\`\`\`

## 2. Validation

### Always use `.safeParse()`

❌ **NEVER DO THIS:**
\`\`\`typescript
const data = schema.parse(req.body); // Throws exception
\`\`\`

✅ **ALWAYS DO THIS:**
\`\`\`typescript
const validation = schema.safeParse(req.body);
if (!validation.success) {
  logger.warn(
    { requestId: ctx.requestId, errors: validation.error.issues },
    "Validation failed"
  );

  return res.error("Validation Error", "Invalid request data", {
    details: validation.error.issues,
    statusCode: 400,
  });
}

const data = validation.data; // Safe to use
\`\`\`

### Use Reusable Schemas

For common patterns, import from \`lib/validation-schemas.ts\`:

\`\`\`typescript
import {
  paginationQuerySchema,
  sortingQuerySchema,
  booleanQuerySchema
} from "../lib/validation-schemas";

const listQuerySchema = paginationQuerySchema
  .merge(sortingQuerySchema)
  .extend({
    status: z.enum(["active", "inactive"]).optional(),
  });
\`\`\`

## 3. Responses

### Success Response

\`\`\`typescript
return res.success(data, {
  message: "Operation completed successfully", // Optional
  statusCode: 201, // Optional, defaults to 200
});
\`\`\`

This automatically adds:
- \`success: true\`
- \`timestamp\`
- \`requestId\`

### Error Response

\`\`\`typescript
return res.error("Not Found", "Item not found", {
  statusCode: 404,
  details: { itemId }, // Optional
});
\`\`\`

This automatically adds:
- \`success: false\`
- \`timestamp\`
- \`requestId\`

### List Response (with pagination)

\`\`\`typescript
const pagination = calculatePagination(page, limit, totalCount);

return res.list(items, pagination, {
  message: \`Found \${totalCount} items\`, // Optional
});
\`\`\`

## 4. Error Handling

### Let the Global Error Handler Handle Unknown Errors

\`\`\`typescript
router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  try {
    // Your code here

    // Known errors - handle explicitly
    if (somethingWrong) {
      return res.error("Bad Request", "Something is wrong", {
        statusCode: 400,
      });
    }

    return res.success(result);
  } catch (error) {
    // Log the error
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        requestId: ctx.requestId,
      },
      "Operation failed"
    );

    // Pass to global error handler
    next(error);
  }
});
\`\`\`

### Handle Known Errors Explicitly

\`\`\`typescript
// Check for specific conditions
if (!item) {
  return res.error("Not Found", "Item not found", { statusCode: 404 });
}

// Check business logic
if (item.isLocked) {
  return res.error("Forbidden", "Cannot modify locked item", { statusCode: 403 });
}
\`\`\`

### Common HTTP Status Codes

| Code | Use Case | Example |
|------|----------|---------|
| 200  | Successful GET/PUT/PATCH | Resource retrieved/updated |
| 201  | Successful POST | Resource created |
| 202  | Accepted (async) | Deployment triggered |
| 204  | Successful DELETE | Resource deleted |
| 400  | Validation error | Invalid request |
| 401  | Not authenticated | Missing/invalid auth |
| 403  | Forbidden | Insufficient permissions |
| 404  | Not found | Resource doesn't exist |
| 409  | Conflict | Duplicate resource |

## 5. Logging

### Standard Logging Pattern

\`\`\`typescript
const ctx = getRequestContext(req);

// Log operation start (debug level)
logger.debug(
  {
    requestId: ctx.requestId,
    userId: ctx.userId,
    operation: "create_item",
  },
  "Operation started"
);

// Log success (debug level)
logger.debug(
  {
    requestId: ctx.requestId,
    userId: ctx.userId,
    itemId: item.id,
  },
  "Item created successfully"
);

// Log validation failures (warn level)
logger.warn(
  {
    requestId: ctx.requestId,
    validationErrors: validation.error.issues,
  },
  "Validation failed"
);

// Log errors (error level)
logger.error(
  {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    requestId: ctx.requestId,
    userId: ctx.userId,
  },
  "Operation failed"
);
\`\`\`

### Log Levels

- \`debug\`: Operation start/end, result counts
- \`info\`: Important business events (deployments, user actions)
- \`warn\`: Validation failures, recoverable issues
- \`error\`: Operation failures, external service errors

### Always Include Context

Every log should include:
- \`requestId\`: For request tracing
- \`userId\`: When available (except unauthenticated endpoints)
- Relevant operation context (itemId, operation name, etc.)

## 6. Pagination

### Standard Pagination Pattern

\`\`\`typescript
import { paginationQuerySchema } from "../lib/validation-schemas";
import { calculatePagination, getPaginationParams } from "../lib/pagination-helpers";

router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  try {
    // Validate pagination params
    const validation = paginationQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.error("Validation Error", "Invalid query parameters", {
        details: validation.error.issues,
        statusCode: 400,
      });
    }

    const { page, limit } = validation.data;
    const { skip, take } = getPaginationParams(page, limit);

    // Fetch data
    const [items, totalCount] = await Promise.all([
      prisma.item.findMany({ skip, take }),
      prisma.item.count(),
    ]);

    // Calculate pagination metadata
    const pagination = calculatePagination(page, limit, totalCount);

    return res.list(items, pagination);
  } catch (error) {
    logger.error({ error, requestId: ctx.requestId }, "Failed to fetch items");
    next(error);
  }
});
\`\`\`

### Default Values

- Default page: 1
- Default limit: 20
- Maximum limit: 100

## 7. Authentication

### Use Centralized Middleware

\`\`\`typescript
import {
  requireSessionOrApiKey,
  getAuthenticatedUser
} from "../middleware/auth";

// Apply to all routes
router.use(requireSessionOrApiKey);

// Or per-route
router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  // Handler code
});
\`\`\`

### Get User Information

\`\`\`typescript
const ctx = getRequestContext(req);

// ctx.userId is automatically extracted from authenticated user
\`\`\`

### Require Authenticated User

For operations that require a user (not API key):

\`\`\`typescript
const ctx = getRequestContext(req);

if (!ctx.userId) {
  return res.error("Unauthorized", "User authentication required", {
    statusCode: 401,
  });
}
\`\`\`

## 8. Complete Examples

### Simple GET Endpoint

\`\`\`typescript
router.get("/:id", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);
  const itemId = req.params.id;

  logger.debug({ requestId: ctx.requestId, itemId }, "Get item requested");

  try {
    const item = await prisma.item.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      return res.error("Not Found", "Item not found", { statusCode: 404 });
    }

    return res.success(item);
  } catch (error) {
    logger.error({ error, requestId: ctx.requestId, itemId }, "Failed to get item");
    next(error);
  }
});
\`\`\`

### POST Endpoint with Validation

\`\`\`typescript
const createItemSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
});

router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  logger.debug({ requestId: ctx.requestId }, "Create item requested");

  try {
    // Require user
    if (!ctx.userId) {
      return res.error("Unauthorized", "User authentication required", {
        statusCode: 401,
      });
    }

    // Validate
    const validation = createItemSchema.safeParse(req.body);
    if (!validation.success) {
      logger.warn(
        { requestId: ctx.requestId, errors: validation.error.issues },
        "Validation failed"
      );

      return res.error("Validation Error", "Invalid request data", {
        details: validation.error.issues,
        statusCode: 400,
      });
    }

    const data = validation.data;

    // Create item
    const item = await prisma.item.create({
      data: {
        ...data,
        createdBy: ctx.userId,
      },
    });

    logger.debug(
      { requestId: ctx.requestId, itemId: item.id },
      "Item created successfully"
    );

    return res.success(item, {
      message: "Item created successfully",
      statusCode: 201,
    });
  } catch (error) {
    logger.error({ error, requestId: ctx.requestId }, "Failed to create item");
    next(error);
  }
});
\`\`\`

### List Endpoint with Pagination

\`\`\`typescript
import { paginationQuerySchema, sortingQuerySchema } from "../lib/validation-schemas";
import { calculatePagination, getPaginationParams } from "../lib/pagination-helpers";

const listQuerySchema = paginationQuerySchema
  .merge(sortingQuerySchema)
  .extend({
    status: z.enum(["active", "inactive"]).optional(),
  });

router.get("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

  logger.debug({ requestId: ctx.requestId, query: req.query }, "List items requested");

  try {
    // Validate query
    const validation = listQuerySchema.safeParse(req.query);
    if (!validation.success) {
      logger.warn(
        { requestId: ctx.requestId, errors: validation.error.issues },
        "Invalid query parameters"
      );

      return res.error("Validation Error", "Invalid query parameters", {
        details: validation.error.issues,
        statusCode: 400,
      });
    }

    const { page, limit, sortBy, sortOrder, status } = validation.data;
    const { skip, take } = getPaginationParams(page, limit);

    // Build where clause
    const where: any = {};
    if (status) where.status = status;

    // Fetch items
    const [items, totalCount] = await Promise.all([
      prisma.item.findMany({
        where,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.item.count({ where }),
    ]);

    const pagination = calculatePagination(page, limit, totalCount);

    logger.debug(
      { requestId: ctx.requestId, totalCount, returnedCount: items.length },
      "Items fetched successfully"
    );

    return res.list(items, pagination, {
      message: \`Found \${totalCount} items\`,
    });
  } catch (error) {
    logger.error({ error, requestId: ctx.requestId }, "Failed to fetch items");
    next(error);
  }
});
\`\`\`

## Checklist for New Routes

Before submitting a PR with new routes, verify:

- [ ] All validation uses \`.safeParse()\`
- [ ] All responses use \`res.success()\`, \`res.error()\`, or \`res.list()\`
- [ ] All errors pass through \`next(error)\` to global handler
- [ ] All logs include \`requestId\` (and \`userId\` when available)
- [ ] Request context extracted with \`getRequestContext()\`
- [ ] Pagination uses helper functions
- [ ] Authentication uses centralized middleware
- [ ] No manual response construction
- [ ] JSDoc comments on route handlers
- [ ] Tests written and passing

## Common Mistakes to Avoid

❌ Using \`.parse()\` instead of \`.safeParse()\`
❌ Manually constructing response objects
❌ Not passing errors to \`next(error)\`
❌ Missing \`requestId\` in logs
❌ Duplicating validation schemas
❌ Manual pagination calculations
❌ Direct access to \`req.user\`

## Getting Help

If you're unsure about a pattern:
1. Check this guide
2. Look at reference implementations:
   - \`containers.ts\` - Complex with pagination
   - \`api-keys.ts\` - Simple CRUD
   - \`deployments.ts\` - Complex business logic
3. Ask in team chat
\`\`\`

### 4.2 Additional Documentation

**Update CLAUDE.md**:
Add a section referencing the new guide:

```markdown
## API Route Development

All new API routes must follow the standardized patterns documented in:
- `.claude/guides/how-to-write-routes.md` - Comprehensive guide for route development

Key principles:
- Use response middleware helpers (\`res.success()\`, \`res.error()\`, \`res.list()\`)
- Validate with \`.safeParse()\`, never \`.parse()\`
- Pass unknown errors to global error handler via \`next(error)\`
- Always include \`requestId\` and \`userId\` in logs
- Use helper libraries for pagination, validation, serialization
```

### 4.3 Deliverables

- [ ] Create `.claude/guides/how-to-write-routes.md`
- [ ] Update `CLAUDE.md` with reference to new guide
- [ ] Create conversion log documenting lessons learned
- [ ] Update project README if necessary

---

## Phase 5: Testing & Quality Assurance (Week 6)

### 5.1 Test Coverage

Ensure all converted routes have:
- [ ] Unit tests for validation schemas
- [ ] Integration tests for route handlers
- [ ] Error case coverage
- [ ] Pagination edge cases

### 5.2 Manual Testing Checklist

For each converted route:
- [ ] Test with valid data
- [ ] Test with invalid data (validation errors)
- [ ] Test authentication/authorization
- [ ] Test pagination (first page, middle page, last page, beyond last)
- [ ] Test error scenarios (not found, conflict, etc.)
- [ ] Verify response structure (success, requestId, timestamp)
- [ ] Verify error handling (global handler catches unknown errors)

### 5.3 Performance Testing

- [ ] Verify no performance regressions
- [ ] Check response times for high-traffic endpoints
- [ ] Monitor memory usage
- [ ] Check log volume (ensure not over-logging)

### 5.4 Code Review

- [ ] All routes follow standardized patterns
- [ ] No direct response construction
- [ ] All validation uses \`.safeParse()\`
- [ ] All errors pass through global handler
- [ ] Consistent logging with context
- [ ] Helper libraries used consistently

---

## Success Metrics

### Quantitative Metrics

- **Code Reduction**: Reduce response construction boilerplate by ~40%
- **Consistency**: 100% of routes use standardized patterns
- **Error Handling**: 0 unhandled errors in production logs
- **Response Format**: 100% of responses include \`requestId\` and \`timestamp\`

### Qualitative Metrics

- **Developer Experience**: New routes easier to write
- **Maintainability**: Consistent patterns across codebase
- **Debuggability**: All requests traceable via \`requestId\`
- **Error Clarity**: Better error messages for clients

---

## Risk Mitigation

### Risk: Breaking Changes to API Clients

**Mitigation**:
- Response structure maintains backwards compatibility
- \`success\`, \`data\`, \`message\` fields remain consistent
- Only adds \`requestId\` and \`timestamp\` (additive change)

### Risk: Performance Impact from Middleware

**Mitigation**:
- Middleware is lightweight (no async operations)
- Response helpers are simple wrappers
- No measurable performance impact expected

### Risk: Developer Resistance to New Patterns

**Mitigation**:
- Clear documentation with examples
- Pilot implementation to prove benefits
- Training session after Phase 2
- Code review enforcement

### Risk: Incomplete Conversion

**Mitigation**:
- Phased approach ensures progress
- Quality gates for each phase
- Dedicated time allocation
- Clear ownership and accountability

---

## Timeline Summary

| Phase | Duration | Key Activities |
|-------|----------|----------------|
| Phase 1 | Week 1 | Create infrastructure (middleware, helpers) |
| Phase 2 | Week 2 | Convert 3 high-traffic routes (pilot) |
| Phase 3 | Week 3-4 | Convert remaining routes in batches |
| Phase 4 | Week 5 | Create developer guide and documentation |
| Phase 5 | Week 6 | Testing, QA, final review |

**Total Duration**: 6 weeks

---

## Next Steps

1. **Review and approve this plan**
2. **Allocate developer resources**
3. **Create tracking board** (GitHub project or similar)
4. **Kick off Phase 1**: Start with middleware and helper libraries
5. **Schedule check-ins**: Weekly progress reviews

---

## Questions?

- How should we track progress? (GitHub project board? Jira?)
- Who will be responsible for code reviews?
- When do we want to start Phase 1?
- Should we have a team training session after Phase 2?
