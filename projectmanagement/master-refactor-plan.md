# Master Refactor Plan: Route Standardization + Zod Schema Architecture

## Executive Summary

This plan combines two critical refactoring initiatives:
1. **Route Standardization** - Implement consistent patterns across all API routes
2. **Zod Schema Architecture** - Create a hybrid approach with shared base schemas and context-specific extensions

**Total Duration**: 7-8 weeks

**Key Benefits**:
- ✅ Single source of truth for validation logic AND TypeScript types
- ✅ Consistent API response formats with proper error handling
- ✅ Reduced code duplication (40% reduction in boilerplate)
- ✅ Type-safe frontend/backend integration
- ✅ Improved developer experience and maintainability

---

## Phase 0: Shared Base Schema Architecture (Week 1)

### Goal
Establish the foundation for shared validation logic before route standardization begins.

### 0.1 Create Shared Base Schemas

**File**: `lib/types/validation.ts` (NEW)

```typescript
import { z } from "zod";

// ====================
// Base Field Validators
// ====================

/**
 * Base port validator (1-65535)
 * No error messages - contexts add their own
 */
export const portNumberSchema = z.number().int().min(1).max(65535);

/**
 * Base hostname validator (RFC 1123)
 * No error messages - contexts add their own
 */
export const hostnameBaseSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/);

/**
 * Base Docker image validator
 * No error messages - contexts add their own
 */
export const dockerImageBaseSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[a-zA-Z0-9\-._/]+(?::[a-zA-Z0-9\-._]+)?$/);

/**
 * Base application name validator
 * No error messages - contexts add their own
 */
export const applicationNameBaseSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9-]+$/);

// ====================
// Base Structural Schemas
// ====================

/**
 * Base deployment port schema
 * Minimal validation, no defaults, no transforms
 */
export const deploymentPortBaseSchema = z.object({
  containerPort: portNumberSchema,
  hostPort: portNumberSchema.optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
});

/**
 * Base deployment volume schema
 */
export const deploymentVolumeBaseSchema = z.object({
  hostPath: z.string().min(1).max(500),
  containerPath: z.string().min(1).max(500),
  mode: z.enum(["rw", "ro"]).optional(),
});

/**
 * Base environment variable schema
 */
export const containerEnvVarBaseSchema = z.object({
  name: z.string().min(1).max(255).regex(/^[A-Z_][A-Z0-9_]*$/),
  value: z.string().max(1000),
});

/**
 * Base container config schema
 */
export const containerConfigBaseSchema = z.object({
  ports: z.array(deploymentPortBaseSchema),
  volumes: z.array(deploymentVolumeBaseSchema),
  environment: z.array(containerEnvVarBaseSchema),
  labels: z.record(z.string(), z.string()),
  networks: z.array(z.string()),
});

// ====================
// Type Inference
// ====================

/**
 * Infer TypeScript types from base schemas
 * This replaces manual interface definitions!
 */
export type DeploymentPort = z.infer<typeof deploymentPortBaseSchema>;
export type DeploymentVolume = z.infer<typeof deploymentVolumeBaseSchema>;
export type ContainerEnvVar = z.infer<typeof containerEnvVarBaseSchema>;
export type ContainerConfig = z.infer<typeof containerConfigBaseSchema>;
```

### 0.2 Create Validation Helpers

**File**: `lib/types/validation-helpers.ts` (NEW)

```typescript
import { z } from "zod";

/**
 * Create a port schema with custom error message
 */
export function createPortSchema(fieldName: string = "Port") {
  return z
    .number()
    .int()
    .min(1, `${fieldName} must be greater than 0`)
    .max(65535, `${fieldName} must be less than 65536`);
}

/**
 * Create a hostname schema with custom error message
 */
export function createHostnameSchema(required: boolean = true) {
  const schema = z
    .string()
    .max(253, "Hostname must be 253 characters or less")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
      "Hostname must be a valid domain name (e.g., example.com, api.example.com)"
    );

  return required ? schema.min(1, "Hostname is required") : schema.optional();
}

/**
 * Create a string length validator with custom bounds
 */
export function createStringSchema(
  min: number,
  max: number,
  fieldName: string = "Field"
) {
  return z
    .string()
    .min(min, `${fieldName} must be at least ${min} characters`)
    .max(max, `${fieldName} must be less than ${max} characters`);
}

/**
 * Create an enum schema with custom error message
 */
export function createEnumSchema<T extends [string, ...string[]]>(
  values: T,
  fieldName: string = "Value"
) {
  return z.enum(values, {
    errorMap: () => ({
      message: `${fieldName} must be one of: ${values.join(", ")}`,
    }),
  });
}
```

### 0.3 Update Shared Types Package

**File**: `lib/types/api.ts` (UPDATE)

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
  response: SuccessResponse<T> | ErrorResponse
): response is SuccessResponse<T> {
  return response.success === true;
}

export function isErrorResponse<T>(
  response: SuccessResponse<T> | ErrorResponse
): response is ErrorResponse {
  return response.success === false;
}
```

### 0.4 Deliverables

- [ ] Create `lib/types/validation.ts` with base schemas
- [ ] Create `lib/types/validation-helpers.ts` with schema factories
- [ ] Update `lib/types/api.ts` with standardized response types
- [ ] Build `@mini-infra/types` package: `cd lib && npm run build`
- [ ] Verify types are importable in both client and server

---

## Phase 1: Foundation - Core Infrastructure (Week 2)

### 1.1 Response Context Middleware

**File**: `server/src/middleware/response-context.ts` (NEW)

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

### 1.2 Global Error Handler

**File**: `server/src/middleware/global-error-handler.ts` (NEW)

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

  // Handle Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
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

  // Zod validation errors
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
    "value",
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

### 1.3 Backend Validation Schemas

**File**: `server/src/lib/validation-schemas.ts` (NEW)

```typescript
import { z } from "zod";
import {
  deploymentPortBaseSchema,
  deploymentVolumeBaseSchema,
  containerEnvVarBaseSchema,
  containerConfigBaseSchema,
} from "@mini-infra/types/validation";

// ====================
// Backend-Specific Extensions
// ====================

/**
 * Standard pagination schema for query parameters
 * BACKEND-ONLY: Transforms query strings to numbers
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

### 1.4 Helper Libraries

**File**: `server/src/lib/pagination-helpers.ts` (NEW)

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

**File**: `server/src/lib/request-context.ts` (NEW)

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

**File**: `server/src/lib/serialization-helpers.ts` (NEW)

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

### 1.5 Update app.ts

**File**: `server/src/app.ts` (UPDATE)

```typescript
import { responseContext } from "./middleware/response-context";
import { globalErrorHandler } from "./middleware/global-error-handler";

// ... existing middleware (cors, helmet, etc.)

// Add response context BEFORE routes
app.use(responseContext);

// ... existing routes registration

// Add global error handler AFTER all routes (MUST BE LAST)
app.use(globalErrorHandler);
```

### 1.6 Deliverables

- [ ] **`lib/types/api.ts`** - Update shared types (FIRST - required by all)
- [ ] **`lib/` package build** - Build shared types: `cd lib && npm run build`
- [ ] `middleware/response-context.ts` - Response helper middleware
- [ ] `middleware/global-error-handler.ts` - Global error handler
- [ ] `lib/validation-schemas.ts` - Backend-specific validation schemas
- [ ] `lib/pagination-helpers.ts` - Pagination utilities
- [ ] `lib/request-context.ts` - Request context extraction
- [ ] `lib/serialization-helpers.ts` - Date serialization
- [ ] Update `app.ts` to register new middleware

---

## Phase 2: Frontend Schema Extensions (Week 3)

### Goal
Update frontend schemas to extend shared base schemas while preserving form-specific features.

### 2.1 Update Frontend Deployment Schemas

**File**: `client/src/components/deployments/schemas.ts` (UPDATE)

```typescript
import { z } from "zod";
import {
  deploymentPortBaseSchema,
  deploymentVolumeBaseSchema,
  containerEnvVarBaseSchema,
  containerConfigBaseSchema,
  portNumberSchema,
  hostnameBaseSchema,
  dockerImageBaseSchema,
  applicationNameBaseSchema,
} from "@mini-infra/types/validation";

// ====================
// Frontend-Specific Extensions
// ====================

/**
 * Frontend deployment port schema
 * - Extends base schema with defaults and UX-friendly messages
 */
export const deploymentPortSchema = z.object({
  containerPort: portNumberSchema.refine(
    (val) => val >= 1 && val <= 65535,
    "Port must be between 1 and 65535"
  ),
  hostPort: portNumberSchema
    .refine(
      (val) => val >= 1 && val <= 65535,
      "Port must be between 1 and 65535"
    )
    .optional(),
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"), // DEFAULT for forms
});

/**
 * Frontend deployment volume schema
 * - User-friendly error messages
 */
export const deploymentVolumeSchema = deploymentVolumeBaseSchema.extend({
  hostPath: z
    .string()
    .min(1, "Host path is required")
    .max(500, "Host path must be less than 500 characters"),
  containerPath: z
    .string()
    .min(1, "Container path is required")
    .max(500, "Container path must be less than 500 characters"),
  mode: z.enum(["rw", "ro"]).optional().default("rw"), // DEFAULT for forms
});

/**
 * Frontend environment variable schema
 * - Detailed regex error message for users
 */
export const containerEnvVarSchema = containerEnvVarBaseSchema.extend({
  name: z
    .string()
    .min(1, "Environment variable name is required")
    .max(255, "Name must be less than 255 characters")
    .regex(
      /^[A-Z_][A-Z0-9_]*$/,
      "Name must start with letter or underscore and contain only uppercase letters, numbers, and underscores"
    ),
});

// Type exports (for React Hook Form)
export type DeploymentPortFormData = z.infer<typeof deploymentPortSchema>;
export type DeploymentVolumeFormData = z.infer<typeof deploymentVolumeSchema>;
export type ContainerEnvVarFormData = z.infer<typeof containerEnvVarSchema>;
```

### 2.2 Update Other Frontend Schemas

Update similar patterns for:
- `client/src/components/postgres/schemas.ts`
- `client/src/app/settings/system/page.tsx` (inline schemas)
- Other component-specific schemas

### 2.3 Deliverables

- [ ] Update `client/src/components/deployments/schemas.ts`
- [ ] Update `client/src/components/postgres/schemas.ts`
- [ ] Update inline schemas in various components
- [ ] Verify React Hook Form integration still works
- [ ] Verify form defaults and error messages are preserved
- [ ] Test all forms to ensure no regressions

---

## Phase 3: Pilot Implementation - High-Traffic Routes (Week 4)

### Goal
Convert 3 high-traffic routes to prove the patterns work end-to-end.

### 3.1 Priority Routes

1. **`containers.ts`** - Most frequently accessed
2. **`deployments.ts`** - Complex, mission-critical
3. **`api-keys.ts`** - Simple, good learning example

### 3.2 Conversion Pattern

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

### 3.3 Quality Gates

For each converted route:
- ✅ All handlers use `.safeParse()` for validation
- ✅ All responses use `res.success()`, `res.error()`, or `res.list()`
- ✅ All errors pass through `next(error)` to global handler
- ✅ All logs include `requestId` and `userId`
- ✅ Pagination uses helper functions
- ✅ Request context uses `getRequestContext()`
- ✅ Uses shared base schemas from `@mini-infra/types`
- ✅ No direct response construction
- ✅ Tests updated and passing

### 3.4 Deliverables

- [ ] Convert `containers.ts` to new patterns
- [ ] Convert `deployments.ts` to new patterns
- [ ] Convert `api-keys.ts` to new patterns
- [ ] Document any issues/learnings in conversion log
- [ ] Update tests for converted routes
- [ ] Verify frontend integration works with new response types

---

## Phase 4: Batch Conversion - Remaining Routes (Week 5-6)

### 4.1 Route Conversion Groups

**Week 5 - Group A: Configuration Routes**
- [ ] `environments.ts`
- [ ] `environment-networks.ts`
- [ ] `environment-volumes.ts`
- [ ] `settings.ts`
- [ ] `system-settings.ts`
- [ ] `deployment-infrastructure.ts`
- [ ] `registry-credentials.ts`

**Week 6 - Group B: Service Routes**
- [ ] `postgres-databases.ts`
- [ ] `postgres-backups.ts`
- [ ] `postgres-backup-configs.ts`
- [ ] `postgres-restore.ts`
- [ ] `postgres-progress.ts`
- [ ] `tls-certificates.ts`
- [ ] `tls-settings.ts`
- [ ] `tls-renewals.ts`

**Week 6 - Group C: Integration Routes**
- [ ] `azure-settings.ts`
- [ ] `azure-connectivity.ts`
- [ ] `cloudflare-settings.ts`
- [ ] `cloudflare-connectivity.ts`
- [ ] `haproxy-frontends.ts`
- [ ] `manual-haproxy-frontends.ts`
- [ ] `deployment-dns.ts`

**Week 6 - Group D: Remaining Routes**
- [ ] `auth.ts` (special case - different patterns)
- [ ] `user-preferences.ts`
- [ ] `settings-self-backup.ts`
- [ ] `self-backups.ts`

### 4.2 Quality Gates (Per Route File)

1. ✅ All handlers use `.safeParse()` for validation
2. ✅ All responses use `res.success()`, `res.error()`, or `res.list()`
3. ✅ All errors pass through `next(error)` to global handler
4. ✅ All logs include `requestId` and `userId`
5. ✅ Pagination uses helper functions
6. ✅ Request context uses `getRequestContext()`
7. ✅ Uses shared base schemas from `@mini-infra/types/validation`
8. ✅ No direct response construction (use middleware helpers)
9. ✅ Tests updated and passing

---

## Phase 5: Schema Migration - Remove Duplication (Week 7)

### Goal
Remove manual TypeScript interfaces that have equivalent Zod schemas.

### 5.1 Identify Duplicated Types

Review `lib/types/*.ts` files and identify interfaces with Zod equivalents:
- `DeploymentPort` → Use `z.infer<typeof deploymentPortBaseSchema>`
- `DeploymentVolume` → Use `z.infer<typeof deploymentVolumeBaseSchema>`
- `ContainerEnvVar` → Use `z.infer<typeof containerEnvVarBaseSchema>`
- `ContainerConfig` → Use `z.infer<typeof containerConfigBaseSchema>`

### 5.2 Migration Pattern

**Before** (duplication):
```typescript
// lib/types/deployments.ts
export interface DeploymentPort {
  containerPort: number;
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}

// client/src/components/deployments/schemas.ts
export const deploymentPortSchema = z.object({
  containerPort: z.number(),
  hostPort: z.number().optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
});
```

**After** (single source):
```typescript
// lib/types/validation.ts
export const deploymentPortBaseSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
});

// Derive TypeScript type from schema
export type DeploymentPort = z.infer<typeof deploymentPortBaseSchema>;
```

### 5.3 Update Imports

Update imports across frontend and backend:
```typescript
// Before
import { DeploymentPort } from "@mini-infra/types/deployments";

// After
import { DeploymentPort } from "@mini-infra/types/validation";
```

### 5.4 Deliverables

- [ ] Remove manual interfaces from `lib/types/deployments.ts`
- [ ] Remove manual interfaces from `lib/types/containers.ts`
- [ ] Remove manual interfaces from `lib/types/postgres.ts`
- [ ] Replace with `export type X = z.infer<typeof XBaseSchema>`
- [ ] Update imports across frontend (client)
- [ ] Update imports across backend (server)
- [ ] Verify TypeScript compilation succeeds
- [ ] Run full test suite to ensure no type errors

---

## Phase 6: Documentation & Developer Guide (Week 8)

### 6.1 Create Comprehensive Developer Guide

**File**: `.claude/guides/how-to-write-routes.md` (NEW)

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
1. Shared Schema Architecture
2. File Structure
3. Validation
4. Responses
5. Error Handling
6. Logging
7. Pagination
8. Authentication
9. Complete Examples

## 1. Shared Schema Architecture

### Using Shared Base Schemas

Import base schemas from `@mini-infra/types/validation`:

\`\`\`typescript
import {
  deploymentPortBaseSchema,
  DeploymentPort, // Inferred type
  portNumberSchema,
} from "@mini-infra/types/validation";
\`\`\`

### Extending for Frontend (with defaults)

\`\`\`typescript
// client/src/components/deployments/schemas.ts
export const deploymentPortSchema = deploymentPortBaseSchema.extend({
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"),
});
\`\`\`

### Extending for Backend (with business logic)

\`\`\`typescript
// server/src/lib/validation-schemas.ts
export const deploymentPortServerSchema = deploymentPortBaseSchema.refine(
  (data) => data.containerPort && data.containerPort > 0,
  "Invalid port configuration"
);
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

### Use Shared Schemas

For common patterns, import from `@mini-infra/types/validation`:

\`\`\`typescript
import {
  deploymentPortBaseSchema,
  containerEnvVarBaseSchema,
} from "@mini-infra/types/validation";

// Extend with backend-specific validation
const createDeploymentSchema = z.object({
  name: z.string().min(1),
  ports: z.array(deploymentPortBaseSchema),
  environment: z.array(containerEnvVarBaseSchema),
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

### Error Response

\`\`\`typescript
return res.error("Not Found", "Item not found", {
  statusCode: 404,
  details: { itemId }, // Optional
});
\`\`\`

### List Response (with pagination)

\`\`\`typescript
const pagination = calculatePagination(page, limit, totalCount);

return res.list(items, pagination, {
  message: \`Found \${totalCount} items\`, // Optional
});
\`\`\`

## 4. Complete Examples

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
import { z } from "zod";

const createItemSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
});

router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  const ctx = getRequestContext(req);

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

## Checklist for New Routes

- [ ] All validation uses \`.safeParse()\`
- [ ] All responses use \`res.success()\`, \`res.error()\`, or \`res.list()\`
- [ ] All errors pass through \`next(error)\`
- [ ] All logs include \`requestId\` (and \`userId\` when available)
- [ ] Request context extracted with \`getRequestContext()\`
- [ ] Uses shared base schemas from \`@mini-infra/types/validation\`
- [ ] Pagination uses helper functions
- [ ] Authentication uses centralized middleware
- [ ] No manual response construction
- [ ] Tests written and passing
\`\`\`

### 6.2 Update CLAUDE.md

Add section referencing the new guide:

```markdown
## API Route Development

All new API routes must follow the standardized patterns documented in:
- `.claude/guides/how-to-write-routes.md` - Comprehensive guide for route development

Key principles:
- Use shared base schemas from `@mini-infra/types/validation`
- Extend schemas for context-specific needs (frontend: defaults, backend: business logic)
- Use response middleware helpers (`res.success()`, `res.error()`, `res.list()`)
- Validate with `.safeParse()`, never `.parse()`
- Pass unknown errors to global error handler via `next(error)`
- Always include `requestId` and `userId` in logs
```

### 6.3 Deliverables

- [ ] Create `.claude/guides/how-to-write-routes.md`
- [ ] Update `CLAUDE.md` with reference to new guide
- [ ] Create conversion log documenting lessons learned
- [ ] Document schema architecture decisions

---

## Success Metrics

### Quantitative Metrics

- **Code Reduction**: Reduce response construction boilerplate by ~40%
- **Type Safety**: 100% of API types derived from Zod schemas
- **Consistency**: 100% of routes use standardized patterns
- **Error Handling**: 0 unhandled errors in production logs
- **Response Format**: 100% of responses include `requestId` and `timestamp`
- **Schema Duplication**: Eliminate 100% of manual TypeScript interface duplication

### Qualitative Metrics

- **Developer Experience**: New routes easier to write
- **Type Safety**: Frontend and backend guaranteed to use same types
- **Maintainability**: Consistent patterns across codebase
- **Debuggability**: All requests traceable via `requestId`
- **Error Clarity**: Better error messages for clients
- **Validation Consistency**: Single source of truth for validation logic

---

## Risk Mitigation

### Risk: Breaking Changes to API Clients

**Mitigation**:
- Response structure maintains backwards compatibility
- `success`, `data`, `message` fields remain consistent
- Only adds `requestId` and `timestamp` (additive change)

### Risk: Type Import Errors

**Mitigation**:
- Ensure `lib` package builds before client/server in all environments
- Document build order in package.json scripts
- Add pre-build checks in CI/CD

### Risk: Schema Migration Errors

**Mitigation**:
- Migrate in phases (shared types first, then frontend, then backend)
- Test thoroughly after each phase
- Keep old interfaces temporarily until migration complete

### Risk: Performance Impact

**Mitigation**:
- Middleware is lightweight (no async operations)
- Response helpers are simple wrappers
- No measurable performance impact expected

---

## Timeline Summary

| Phase | Duration | Key Activities |
|-------|----------|----------------|
| Phase 0 | Week 1 | Create shared base schema architecture |
| Phase 1 | Week 2 | Create infrastructure (middleware, helpers) |
| Phase 2 | Week 3 | Update frontend schemas to extend base schemas |
| Phase 3 | Week 4 | Convert 3 high-traffic routes (pilot) |
| Phase 4 | Week 5-6 | Convert remaining routes in batches |
| Phase 5 | Week 7 | Remove TypeScript interface duplication |
| Phase 6 | Week 8 | Create developer guide and documentation |

**Total Duration**: 8 weeks

---

## Next Steps

1. **Review and approve this plan**
2. **Allocate developer resources**
3. **Create tracking board** (GitHub project or similar)
4. **Kick off Phase 0**: Start with shared base schemas in `lib/types/validation.ts`
5. **Schedule check-ins**: Weekly progress reviews

---

## Appendix: Architecture Diagrams

### Schema Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   @mini-infra/types                         │
│                   (lib/types)                               │
├─────────────────────────────────────────────────────────────┤
│  1. Base Zod Schemas (validation.ts)                        │
│     - Core validation logic shared by frontend + backend    │
│     - No defaults, no transforms, no UI-specific messages   │
│     - Pure structural validation                            │
│                                                              │
│  2. TypeScript Types (via z.infer<>)                        │
│     - DeploymentPort, ContainerConfig, etc.                 │
│     - Single source of truth for types AND validation       │
│                                                              │
│  3. Validation Helpers (validation-helpers.ts)              │
│     - Reusable field validators (port, hostname, etc.)      │
│                                                              │
│  4. API Response Types (api.ts)                             │
│     - SuccessResponse<T>, ListResponse<T>, ErrorResponse    │
│     - Type guards for frontend                              │
└─────────────────────────────────────────────────────────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
    ┌─────────────────────┐   ┌─────────────────────┐
    │  Frontend Schemas   │   │  Backend Schemas    │
    │  (client/src)       │   │  (server/src)       │
    ├─────────────────────┤   ├─────────────────────┤
    │ Base schemas +      │   │ Base schemas +      │
    │ - Form defaults     │   │ - Auth checks       │
    │ - UX messages       │   │ - DB constraints    │
    │ - UI transforms     │   │ - Security rules    │
    │ - Progressive val.  │   │ - Query transforms  │
    └─────────────────────┘   └─────────────────────┘
```

### Request Flow

```
Client Request
     │
     ▼
[Response Context Middleware]
     │ - Add requestId, timestamp
     │ - Attach res.success(), res.error(), res.list()
     ▼
[Route Handler]
     │ - getRequestContext(req)
     │ - Validate with .safeParse()
     │ - Business logic
     │ - res.success(data) OR next(error)
     ▼
[Global Error Handler]
     │ - Catch unhandled errors
     │ - Log with full context
     │ - Return standardized error response
     ▼
Client Response
     │ - Always includes: success, timestamp, requestId
     │ - Success: data, pagination (if list), message
     │ - Error: error, message, details
```

---

**Document Version**: 1.0
**Date**: 2025-01-11
**Author**: Claude Code (Sonnet 4.5)
**Status**: Draft - Pending Review
