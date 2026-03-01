# Zod Schema Architecture Analysis

## Executive Summary

This document analyzes the current Zod validation schema architecture across the Mini Infra application and provides recommendations for organizing validation logic between the shared types library (`@mini-infra/types`), frontend, and backend.

**Key Finding**: Significant schema duplication exists between frontend and backend, but there are valid architectural reasons to maintain separate schemas in many cases. The solution is a **hybrid approach** that shares base schemas while allowing frontend and backend-specific extensions.

---

## Current State Analysis

### 1. Backend Validation Schemas (`server/src`)

**Location**: Primarily inline in route files

**Examples**:
- `routes/api-keys.ts` - API key creation validation
- `routes/deployments.ts` - Deployment configuration validation
- `routes/containers.ts` - Container query parameter validation
- `routes/user-preferences.ts` - User preference validation
- `routes/postgres-backups.ts` - Backup configuration validation

**Characteristics**:
- ✅ **Server-side security validation** - Validates untrusted client input
- ✅ **Business logic enforcement** - Enforces database constraints, authorization rules
- ✅ **Type transformation** - Converts query strings to numbers, dates, etc.
- ✅ **Comprehensive error details** - Provides structured validation errors for API responses
- ❌ **Duplication** - Many schemas mirror frontend validation with minor differences
- ❌ **No centralization** - Common patterns (pagination, sorting) are repeated across files

**Current Pattern**:
```typescript
// server/src/routes/api-keys.ts
const createApiKeySchema = z.object({
  name: z
    .string()
    .min(1, "API key name is required")
    .max(100, "API key name must be less than 100 characters")
    .regex(/^[a-zA-Z0-9\s\-_]+$/, "API key name can only contain..."),
});

const validationResult = createApiKeySchema.safeParse(req.body);
if (!validationResult.success) {
  return res.status(400).json({
    error: "Validation error",
    details: validationResult.error.issues,
  });
}
```

---

### 2. Frontend Validation Schemas (`client/src`)

**Location**: Mixed - dedicated schema files and inline in components

**Examples**:
- `components/deployments/schemas.ts` - Comprehensive deployment validation (168 lines)
- `components/postgres/schemas.ts` - PostgreSQL configuration validation
- `app/settings/system/page.tsx` - System settings inline validation
- `components/api-keys/create-api-key-dialog.tsx` - API key inline validation

**Characteristics**:
- ✅ **User experience focus** - Detailed, user-friendly error messages
- ✅ **Real-time validation** - Validates as user types for immediate feedback
- ✅ **Form-specific** - Tightly coupled to React Hook Form and UI components
- ✅ **Default values** - Provides sensible defaults for form fields
- ❌ **Duplication** - Mirrors backend validation with slight variations
- ❌ **Inconsistent organization** - Some in dedicated files, some inline

**Current Pattern**:
```typescript
// client/src/components/deployments/schemas.ts
export const deploymentPortSchema = z.object({
  containerPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  hostPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536")
    .optional(),
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"),
});

// Used with React Hook Form
const form = useForm<DeploymentPortFormData>({
  resolver: zodResolver(deploymentPortSchema),
  defaultValues: { protocol: "tcp" },
});
```

---

### 3. Shared Types (`lib/types`)

**Location**: TypeScript interface definitions only

**Examples**:
- `types/deployments.ts` - DeploymentPort, DeploymentVolume, ContainerConfig interfaces
- `types/api.ts` - API response structures (ApiResponse, PaginationParams)
- `types/postgres.ts` - PostgreSQL database types
- `types/containers.ts` - Container info types

**Characteristics**:
- ✅ **Single source of truth** for TypeScript types
- ✅ **Frontend/backend consistency** - Both sides use same type definitions
- ✅ **Type safety** - Compile-time type checking
- ❌ **No runtime validation** - Types are erased at runtime (TypeScript limitation)
- ❌ **No Zod schemas** - Currently only TypeScript interfaces, no validation logic

**Current Pattern**:
```typescript
// lib/types/deployments.ts
export interface DeploymentPort {
  containerPort: number;
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}

// Frontend uses this type
const port: DeploymentPort = { containerPort: 8080, protocol: "tcp" };

// Backend uses this type
const ports: DeploymentPort[] = validatedData.ports;
```

---

## Problem: Schema Duplication

### Example: Deployment Port Validation

**Frontend Schema** (`client/src/components/deployments/schemas.ts`):
```typescript
export const deploymentPortSchema = z.object({
  containerPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  hostPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536")
    .optional(),
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"),
});
```

**Backend Schema** (would be in route handler, but currently relies on frontend):
```typescript
// Currently implicit - backend trusts validated data from shared types
// But should have its own validation!
```

**Shared Type** (`lib/types/deployments.ts`):
```typescript
export interface DeploymentPort {
  containerPort: number;
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}
```

**Problems**:
1. ❌ **Three sources of truth** - TypeScript interface, frontend schema, (missing) backend schema
2. ❌ **Synchronization burden** - Changes must be made in multiple places
3. ❌ **Inconsistent validation** - Frontend and backend rules can drift apart
4. ❌ **No type inference** - Shared TypeScript type doesn't derive from validation schema

---

## Why Separate Schemas Make Sense

### 1. Different Validation Requirements

**Frontend-Specific Validation**:
- Form defaults (`default("tcp")`)
- User-friendly error messages ("Port must be greater than 0")
- Progressive validation (validate as user types)
- Form-specific transformations (empty string → undefined)
- Client-side only fields (e.g., password confirmation)

**Backend-Specific Validation**:
- Security enforcement (sanitization, SQL injection prevention)
- Business logic (authorization, resource limits, ownership checks)
- Database constraints (unique, foreign key, not null)
- Query string transformations (`"10"` → `10`)
- Server-side only fields (e.g., userId, requestId, timestamps)

### 2. Different Error Handling

**Frontend**:
```typescript
// User-friendly, inline form errors
"API key name can only contain letters, numbers, spaces, hyphens, and underscores"
```

**Backend**:
```typescript
// API error response with structured details
{
  error: "Validation Error",
  message: "Invalid request data",
  details: [
    { path: ["name"], message: "Invalid format", code: "invalid_string" }
  ]
}
```

### 3. Different Security Contexts

**Frontend**:
- User convenience (helpful messages, defaults)
- UX optimization (prevent invalid submissions)
- Not trusted (user can bypass via DevTools)

**Backend**:
- Security enforcement (last line of defense)
- Cannot be bypassed
- Must validate ALL input (including API clients, not just browser)

---

## Recommended Architecture

### Hybrid Approach: Shared Base Schemas + Context-Specific Extensions

```
┌─────────────────────────────────────────────────────────────┐
│                   @mini-infra/types                         │
│                   (lib/types)                               │
├─────────────────────────────────────────────────────────────┤
│  1. TypeScript Interfaces (existing)                        │
│     - DeploymentPort, ContainerConfig, etc.                 │
│                                                              │
│  2. Base Zod Schemas (NEW)                                  │
│     - Core validation logic shared by frontend + backend    │
│     - No defaults, no transforms, no UI-specific messages   │
│     - Pure structural validation                            │
│                                                              │
│  3. Common Validation Helpers (NEW)                         │
│     - Reusable field validators (port, hostname, etc.)      │
│     - Standard patterns (pagination, sorting)               │
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

---

## Implementation Plan

### Phase 1: Create Shared Base Schemas

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

**Benefits**:
- ✅ **Single source of truth** for validation logic AND TypeScript types
- ✅ **Type inference** - TypeScript types derived from schemas (`z.infer<>`)
- ✅ **Shared validation** - Core rules defined once
- ✅ **No duplication** - Base schemas imported by frontend and backend
- ✅ **Flexible** - Contexts extend base schemas with specific needs

---

### Phase 2: Frontend Schema Extensions

**File**: `client/src/components/deployments/schemas.ts` (UPDATED)

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

/**
 * Frontend container config schema
 * - Extends base with defaults for empty arrays
 */
export const containerConfigSchema = containerConfigBaseSchema.extend({
  ports: z.array(deploymentPortSchema).default([]),
  volumes: z.array(deploymentVolumeSchema).default([]),
  environment: z.array(containerEnvVarSchema).default([]),
  labels: z.record(z.string(), z.string()).default({}),
  networks: z.array(z.string()).default([]),
});

// Type exports (for React Hook Form)
export type DeploymentPortFormData = z.infer<typeof deploymentPortSchema>;
export type DeploymentVolumeFormData = z.infer<typeof deploymentVolumeSchema>;
export type ContainerEnvVarFormData = z.infer<typeof containerEnvVarSchema>;
export type ContainerConfigFormData = z.infer<typeof containerConfigSchema>;
```

**Frontend-Specific Additions**:
- ✅ Form defaults (`.default()`)
- ✅ User-friendly error messages
- ✅ Progressive validation hints
- ✅ Type exports for React Hook Form

---

### Phase 3: Backend Schema Extensions

**File**: `server/src/lib/validation-schemas.ts` (UPDATED - mentioned in implementation plan)

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
// Backend-Specific Extensions
// ====================

/**
 * Backend deployment port schema
 * - No defaults (client must provide)
 * - Generic error messages (API consumers)
 * - Server-side validation only
 */
export const deploymentPortServerSchema = deploymentPortBaseSchema.refine(
  (data) => data.containerPort && data.containerPort > 0,
  "Invalid port configuration"
);

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

**Backend-Specific Additions**:
- ✅ Query string transformations (`string → number`, `string → Date`)
- ✅ Security-focused validation (no client-side bypasses)
- ✅ Business logic enforcement (ownership, authorization)
- ✅ Generic error messages (API consumers, not just browser users)

---

### Phase 4: Common Validation Helpers

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

---

## Decision Matrix: Where Should Schemas Live?

| Schema Type | Location | Reasoning |
|-------------|----------|-----------|
| **Core structural schemas** (DeploymentPort, ContainerConfig, etc.) | `lib/types/validation.ts` | Shared validation logic, single source of truth |
| **Common field validators** (port, hostname, UUID, etc.) | `lib/types/validation.ts` | Reusable across frontend/backend |
| **Form validation with defaults** | `client/src/components/*/schemas.ts` | Form-specific, UX-focused, React Hook Form integration |
| **Query parameter schemas** (pagination, sorting, filters) | `server/src/lib/validation-schemas.ts` | Backend-only, query string transformations |
| **API request validation** (create, update, delete) | `server/src/routes/*.ts` OR `server/src/lib/validation-schemas.ts` | Backend-only, business logic, authorization |
| **Validation helpers/factories** | `lib/types/validation-helpers.ts` | Reusable schema generators |

---

## Specific Schema Recommendations

### 1. ✅ MOVE TO SHARED (lib/types/validation.ts)

**Rationale**: Core validation logic used by both frontend and backend

- ✅ `deploymentPortBaseSchema` - Port validation (1-65535, tcp/udp)
- ✅ `deploymentVolumeBaseSchema` - Volume path validation
- ✅ `containerEnvVarBaseSchema` - Environment variable validation
- ✅ `containerConfigBaseSchema` - Container configuration structure
- ✅ `healthCheckConfigBaseSchema` - Health check configuration
- ✅ `rollbackConfigBaseSchema` - Rollback configuration
- ✅ `portNumberSchema` - Generic port validator (1-65535)
- ✅ `hostnameBaseSchema` - Hostname format validation (RFC 1123)
- ✅ `dockerImageBaseSchema` - Docker image format validation
- ✅ `applicationNameBaseSchema` - Application name format (lowercase, hyphen)
- ✅ `postgresConnectionBaseSchema` - PostgreSQL connection parameters
- ✅ `backupConfigBaseSchema` - Backup configuration structure

### 2. ⚠️ KEEP FRONTEND-SPECIFIC (client/src)

**Rationale**: Form defaults, UX messages, React Hook Form integration

- ⚠️ Form schemas with `.default()` - Form initialization values
- ⚠️ Schemas with detailed error messages - User-facing validation feedback
- ⚠️ Progressive validation schemas - Real-time form validation
- ⚠️ UI-specific transformations - Empty string → undefined, etc.

**Examples**:
- `client/src/components/deployments/schemas.ts` - Extend base schemas with defaults
- `client/src/components/postgres/schemas.ts` - PostgreSQL form schemas
- `client/src/app/settings/system/page.tsx` - System settings form schemas

### 3. ⚠️ KEEP BACKEND-SPECIFIC (server/src)

**Rationale**: Query string transforms, authorization, business logic

- ⚠️ `paginationQuerySchema` - Query string → number transformation
- ⚠️ `sortingQuerySchema` - Query parameter validation
- ⚠️ `booleanQuerySchema` - Query string → boolean transformation
- ⚠️ `isoDateSchema` - String → Date transformation
- ⚠️ `uuidParamSchema` - UUID route parameter validation
- ⚠️ `cuidParamSchema` - CUID route parameter validation
- ⚠️ Authorization-specific schemas - User ownership, permissions, etc.

**Examples**:
- `server/src/lib/validation-schemas.ts` - Common backend validators
- `server/src/routes/*.ts` - Route-specific request validation

### 4. ❌ REMOVE DUPLICATION

**Current Issue**: Manual TypeScript interfaces + separate Zod schemas

**Solution**: Derive TypeScript types from Zod schemas using `z.infer<>`

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

---

## Migration Strategy

### Step 1: Create Base Schemas (Week 1)

**Deliverables**:
- [ ] `lib/types/validation.ts` - Core base schemas
- [ ] `lib/types/validation-helpers.ts` - Reusable schema generators
- [ ] Build `@mini-infra/types` package with new validation exports
- [ ] Update frontend/backend to import new shared schemas

**Approach**:
1. Start with most commonly used schemas (port, hostname, Docker image)
2. Extract base validation logic (no defaults, no transforms, no messages)
3. Export base schemas and inferred types
4. Add JSDoc comments explaining "base" vs "context-specific"

### Step 2: Update Frontend Schemas (Week 2)

**Deliverables**:
- [ ] Update `client/src/components/deployments/schemas.ts` to extend base schemas
- [ ] Update `client/src/components/postgres/schemas.ts` to extend base schemas
- [ ] Update inline schemas in components to extend base schemas
- [ ] Verify React Hook Form integration still works
- [ ] Verify form defaults and error messages are preserved

**Approach**:
1. Import base schemas from `@mini-infra/types/validation`
2. Extend with `.extend()`, `.refine()`, `.transform()`, `.default()`
3. Add user-friendly error messages
4. Keep form-specific logic (defaults, progressive validation)
5. Test all forms to ensure no regressions

### Step 3: Update Backend Schemas (Week 3)

**Deliverables**:
- [ ] Create `server/src/lib/validation-schemas.ts` with backend-specific schemas
- [ ] Update route handlers to import base schemas from `@mini-infra/types`
- [ ] Update route handlers to import backend schemas from `lib/validation-schemas.ts`
- [ ] Ensure query string transformations are preserved
- [ ] Verify API validation behavior is unchanged

**Approach**:
1. Move common backend patterns to `server/src/lib/validation-schemas.ts`:
   - Pagination, sorting, filtering
   - Query string transformations
   - Common parameter validators
2. Update route files to import base schemas
3. Extend base schemas with backend-specific rules (auth, business logic)
4. Test API endpoints to ensure validation still works

### Step 4: Remove Duplication (Week 4)

**Deliverables**:
- [ ] Remove manual TypeScript interfaces from `lib/types/*.ts` that have Zod equivalents
- [ ] Replace with `export type X = z.infer<typeof XSchema>`
- [ ] Update imports across frontend and backend
- [ ] Verify TypeScript compilation succeeds
- [ ] Run full test suite to ensure no type errors

**Approach**:
1. Identify TypeScript interfaces with equivalent Zod schemas
2. Delete manual interface definitions
3. Export inferred types: `export type X = z.infer<typeof XBaseSchema>`
4. Update imports from `import { X } from "@mini-infra/types"` to `import { X } from "@mini-infra/types/validation"`
5. Compile and test

---

## Example: Full Migration of Deployment Port

### Before (Current State)

**lib/types/deployments.ts** (manual interface):
```typescript
export interface DeploymentPort {
  containerPort: number;
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}
```

**client/src/components/deployments/schemas.ts** (frontend schema):
```typescript
export const deploymentPortSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"),
});

export type DeploymentPortFormData = z.infer<typeof deploymentPortSchema>;
```

**server/src/routes/deployments.ts** (backend validation):
```typescript
// Currently implicit - relies on frontend validation
// Backend should validate but doesn't have explicit schema
```

### After (Migrated)

**lib/types/validation.ts** (base schema):
```typescript
import { z } from "zod";

/**
 * Base deployment port schema
 * - Used by both frontend and backend
 * - No defaults, no transforms, no UI-specific messages
 * - Pure structural validation
 */
export const deploymentPortBaseSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
});

/**
 * TypeScript type inferred from base schema
 * This replaces the manual interface definition!
 */
export type DeploymentPort = z.infer<typeof deploymentPortBaseSchema>;
```

**client/src/components/deployments/schemas.ts** (frontend extension):
```typescript
import { deploymentPortBaseSchema } from "@mini-infra/types/validation";
import { z } from "zod";

/**
 * Frontend deployment port schema
 * - Extends base schema with form-specific features
 * - Adds default values for React Hook Form
 * - Adds user-friendly error messages
 */
export const deploymentPortSchema = deploymentPortBaseSchema.extend({
  containerPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  hostPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536")
    .optional(),
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"),
});

export type DeploymentPortFormData = z.infer<typeof deploymentPortSchema>;
```

**server/src/lib/validation-schemas.ts** (backend extension):
```typescript
import { deploymentPortBaseSchema } from "@mini-infra/types/validation";
import { z } from "zod";

/**
 * Backend deployment port schema
 * - Extends base schema with server-side validation
 * - No defaults (client must provide all values)
 * - Generic error messages for API responses
 */
export const deploymentPortServerSchema = deploymentPortBaseSchema;
// Can add refinements for business logic, authorization, etc.
```

**server/src/routes/deployments.ts** (backend route):
```typescript
import { deploymentPortServerSchema } from "../lib/validation-schemas";

router.post("/", requireSessionOrApiKey, async (req, res, next) => {
  // Validate with server-side schema
  const validation = deploymentPortServerSchema.safeParse(req.body.port);
  if (!validation.success) {
    return res.error("Validation Error", "Invalid port configuration", {
      details: validation.error.issues,
      statusCode: 400,
    });
  }

  // Use validated data
  const port = validation.data; // Type: DeploymentPort
});
```

**Benefits**:
- ✅ **Single source of truth** for validation logic (`lib/types/validation.ts`)
- ✅ **Type inference** - TypeScript type derived from schema (`z.infer<>`)
- ✅ **Frontend extension** - Form defaults and UX messages
- ✅ **Backend extension** - Server-side validation and business logic
- ✅ **No duplication** - Core validation logic defined once
- ✅ **Type safety** - Frontend and backend use same base type

---

## Conclusion

### Summary of Recommendations

1. ✅ **Create shared base schemas** in `lib/types/validation.ts`
   - Core validation logic for structural schemas
   - Common field validators (port, hostname, UUID, etc.)
   - No defaults, no transforms, no UI-specific messages

2. ✅ **Keep frontend-specific schemas** in `client/src/components/*/schemas.ts`
   - Extend base schemas with form defaults (`.default()`)
   - Add user-friendly error messages
   - Handle progressive validation and React Hook Form integration

3. ✅ **Keep backend-specific schemas** in `server/src/lib/validation-schemas.ts`
   - Extend base schemas with business logic
   - Add query string transformations (`string → number`)
   - Handle authorization and security validation

4. ✅ **Derive TypeScript types from Zod schemas**
   - Replace manual interfaces with `z.infer<typeof schema>`
   - Single source of truth for types AND validation
   - Eliminates synchronization burden

5. ✅ **Use validation helpers** in `lib/types/validation-helpers.ts`
   - Factory functions for creating custom schemas
   - Reusable schema generators
   - Consistent validation patterns across contexts

### Benefits of Hybrid Approach

- ✅ **Reduces duplication** - Core validation logic defined once
- ✅ **Maintains flexibility** - Contexts extend base schemas as needed
- ✅ **Improves type safety** - TypeScript types derived from validation schemas
- ✅ **Preserves UX** - Frontend can add defaults and friendly messages
- ✅ **Ensures security** - Backend enforces validation independently
- ✅ **Simplifies maintenance** - Changes to core validation propagate automatically

### Trade-offs

- ⚠️ **Slightly more complex** - Three layers (base, frontend, backend) instead of two
- ⚠️ **Build dependency** - `@mini-infra/types` must build before client/server
- ⚠️ **Migration effort** - Requires refactoring existing schemas

### Next Steps

1. Review and approve this architecture plan
2. Begin Phase 1: Create base schemas in `lib/types/validation.ts`
3. Update build process to ensure `@mini-infra/types` builds first
4. Migrate high-traffic routes first (deployments, containers, api-keys)
5. Document usage patterns in `CLAUDE.md` and `.claude/guides/`

---

## Appendix: Schema Organization Reference

### File Structure After Migration

```
mini-infra/
├── lib/types/                          # Shared types package
│   ├── validation.ts                  # NEW: Base validation schemas
│   ├── validation-helpers.ts          # NEW: Schema factories/generators
│   ├── api.ts                         # Existing: API response types
│   ├── deployments.ts                 # UPDATED: Remove interfaces, use z.infer
│   ├── containers.ts                  # UPDATED: Remove interfaces, use z.infer
│   ├── postgres.ts                    # UPDATED: Remove interfaces, use z.infer
│   └── ...                            # Other type files
│
├── client/src/
│   └── components/
│       ├── deployments/
│       │   └── schemas.ts             # Frontend schemas (extend base + defaults)
│       ├── postgres/
│       │   └── schemas.ts             # Frontend schemas (extend base + defaults)
│       └── ...
│
└── server/src/
    ├── lib/
    │   └── validation-schemas.ts      # Backend schemas (extend base + transforms)
    └── routes/
        ├── deployments.ts             # Import from lib/validation-schemas.ts
        ├── containers.ts              # Import from lib/validation-schemas.ts
        └── ...
```

### Import Patterns After Migration

**Frontend Component**:
```typescript
// Import base schemas from shared types
import {
  deploymentPortBaseSchema,
  DeploymentPort, // Inferred type
} from "@mini-infra/types/validation";

// Import validation helpers
import { createPortSchema } from "@mini-infra/types/validation-helpers";

// Extend with frontend-specific features
export const deploymentPortSchema = deploymentPortBaseSchema.extend({
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"),
});
```

**Backend Route**:
```typescript
// Import base schemas from shared types
import {
  deploymentPortBaseSchema,
  DeploymentPort, // Inferred type
} from "@mini-infra/types/validation";

// Import backend validation helpers
import {
  paginationQuerySchema,
  sortingQuerySchema,
} from "../lib/validation-schemas";

// Use base schema or extend with business logic
const validation = deploymentPortBaseSchema.safeParse(req.body);
```

---

**Document Version**: 1.0
**Date**: 2025-01-11
**Author**: Claude Code (Sonnet 4.5)
**Status**: Draft - Pending Review
