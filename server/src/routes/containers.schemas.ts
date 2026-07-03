import { z } from "zod";
import "../lib/openapi-registry";
import type {
  ContainerInfo,
  ContainerPort,
  ContainerVolume,
  ContainerStatus,
  ContainerListResponse,
  ContainerListApiResponse,
  ContainerCacheResponse,
  ContainerCacheFlushResponse,
  ContainerActionResponse,
  ContainerAction,
} from "@mini-infra/types/containers";
import type { ApiResponse } from "@mini-infra/types";
import { SORT_ORDERS, DEFAULT_LOG_TAIL_LINES, MAX_LOG_TAIL_LINES } from "@mini-infra/types";

/**
 * Response-validation strictness note (Phase 9, plan §6):
 *
 * `describeRoute()` (`server/src/lib/describe-route.ts`) does NOT run any of
 * these `response` schemas against the outgoing body at request time — it
 * only feeds them to the OpenAPI registry (for `/api/openapi.json`) and to
 * TypeScript (via the `satisfies z.ZodType<...>` conformance checks below).
 * There is no `.parse()`/`.safeParse()` call on a response anywhere in
 * `describe-route.ts`. That means the `services[].vaultAppRoleRef`
 * unknown-key-stripping footgun documented in `server/CLAUDE.md` cannot bite
 * here today: nothing strips fields from a real response body. Schemas below
 * are therefore written to be *accurate* (mirroring the shared
 * `@mini-infra/types` interfaces exactly) rather than defensively
 * `.passthrough()`'d. If a future phase wires response schemas into an
 * actual runtime-validating middleware, revisit this file first and add
 * `.passthrough()` to every object schema before flipping that on.
 */

// ====================
// Shared container-shape schemas
// ====================

const ContainerStatusSchema = z.enum([
  "running",
  "stopped",
  "restarting",
  "paused",
  "exited",
]) satisfies z.ZodType<ContainerStatus>;

const ContainerPortSchema = z.object({
  private: z.number(),
  public: z.number().optional(),
  type: z.enum(["tcp", "udp"]),
}) satisfies z.ZodType<ContainerPort>;

const ContainerVolumeSchema = z.object({
  source: z.string(),
  destination: z.string(),
  mode: z.enum(["rw", "ro"]),
}) satisfies z.ZodType<ContainerVolume>;

/**
 * Mirrors `ContainerInfo` (`lib/types/containers.ts`) exactly.
 *
 * `deploymentInfo` is part of the shared contract but is never populated by
 * the server today (see `services/container-serializer.ts` — nothing sets
 * it); kept optional here to match the type without asserting it's live.
 */
export const ContainerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: ContainerStatusSchema,
  image: z.string(),
  imageTag: z.string(),
  ports: z.array(ContainerPortSchema),
  volumes: z.array(ContainerVolumeSchema),
  ipAddress: z.string().optional(),
  createdAt: z.string().openapi({ description: "ISO 8601 timestamp" }),
  startedAt: z.string().optional().openapi({ description: "ISO 8601 timestamp" }),
  labels: z.record(z.string(), z.string()),
  deploymentInfo: z
    .object({
      deploymentId: z.string(),
      applicationName: z.string(),
      containerRole: z.string(),
    })
    .optional(),
  environmentInfo: z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
    })
    .optional(),
  selfRole: z
    .enum(["main", "agent-sidecar", "update-sidecar", "fw-agent"])
    .optional(),
}) satisfies z.ZodType<ContainerInfo>;

/** Generic `{ success, data }` envelope, scoped to a specific data schema. */
function apiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.boolean(),
    data: dataSchema,
    message: z.string().optional(),
  });
}

// ====================
// GET /api/containers — list
// ====================

export const ContainerQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 1;
      const parsed = parseInt(val);
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
      if (!val) return 50;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Limit must be a positive integer",
        });
        return z.NEVER;
      }
      return Math.min(parsed, 50); // Maximum 50 containers per page
    }),
  sortBy: z.string().optional().default("name"),
  sortOrder: z.enum(SORT_ORDERS).optional().default("asc"),
  status: z.string().optional(),
  name: z.string().optional(),
  image: z.string().optional(),
  deploymentId: z.string().optional(),
});

export const ContainerListResponseSchema = z.object({
  containers: z.array(ContainerInfoSchema),
  totalCount: z.number(),
  lastUpdated: z.string().openapi({ description: "ISO 8601 timestamp" }),
  page: z.number().optional(),
  limit: z.number().optional(),
}) satisfies z.ZodType<ContainerListResponse>;

export const ContainerListApiResponseSchema = z.object({
  success: z.boolean(),
  data: ContainerListResponseSchema,
  message: z.string().optional(),
}) satisfies z.ZodType<ContainerListApiResponse>;

// ====================
// GET /api/containers/postgres
// ====================

export const PostgresContainersResponseSchema = apiResponseSchema(
  z.array(ContainerInfoSchema),
) satisfies z.ZodType<ApiResponse<ContainerInfo[]>>;

// ====================
// GET /api/containers/managed-ids
// ====================

export const ManagedContainerIdsResponseSchema = apiResponseSchema(
  z.record(z.string(), z.string()),
) satisfies z.ZodType<ApiResponse<Record<string, string>>>;

// ====================
// GET /api/containers/:id
// ====================

export const ContainerIdParams = z.object({
  id: z.string().openapi({ description: "Docker container ID or ID prefix" }),
});

/** Bare `ContainerInfo` — this route does NOT use the `{success,data}` envelope. */
export const ContainerDetailResponseSchema = ContainerInfoSchema;

// ====================
// GET /api/containers/:id/env
// ====================

export const ContainerEnvResponseSchema = apiResponseSchema(
  z.record(z.string(), z.string()),
) satisfies z.ZodType<ApiResponse<Record<string, string>>>;

// ====================
// GET /api/containers/stats/cache
// ====================

export const ContainerCacheStatsResponseSchema = z.object({
  cache: z.object({
    keys: z.number(),
    stats: z.object({
      hits: z.number(),
      misses: z.number(),
      keys: z.number(),
      ksize: z.number(),
      vsize: z.number(),
    }),
  }),
  dockerConnected: z.boolean(),
  timestamp: z.string(),
  requestId: z.string().optional(),
}) satisfies z.ZodType<ContainerCacheResponse>;

// ====================
// POST /api/containers/cache/flush
// ====================

export const ContainerCacheFlushResponseSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
  requestId: z.string().optional(),
}) satisfies z.ZodType<ContainerCacheFlushResponse>;

// ====================
// GET /api/containers/:id/logs/stream
// ====================

/**
 * Same schema used for the real `.safeParse()` validation in the route
 * handler (moved here verbatim, not duplicated) and for the `request.query`
 * OpenAPI metadata passed to `describe()`.
 */
export const ContainerLogsQuerySchema = z.object({
  tail: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : DEFAULT_LOG_TAIL_LINES))
    .refine((val) => val > 0 && val <= MAX_LOG_TAIL_LINES, {
      message: `Tail must be between 1 and ${MAX_LOG_TAIL_LINES}`,
    })
    .openapi({ description: `Lines to tail (default ${DEFAULT_LOG_TAIL_LINES}, max ${MAX_LOG_TAIL_LINES})` }),
  follow: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val !== "false")
    .openapi({ description: "Stream in real time (default true)" }),
  timestamps: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
  stdout: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val !== "false"),
  stderr: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val !== "false"),
  since: z.string().optional(),
  until: z.string().optional(),
});

// ====================
// POST /api/containers/:id/:action
// ====================

const CONTAINER_ACTIONS = ["start", "stop", "restart", "remove"] as const;

export const ContainerActionParams = z.object({
  id: z.string().openapi({ description: "Docker container ID or ID prefix" }),
  action: z
    .enum(CONTAINER_ACTIONS)
    .openapi({ description: "Lifecycle action to perform" }),
}) satisfies z.ZodType<{ id: string; action: ContainerAction }>;

export const ContainerActionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  containerId: z.string(),
  action: z.enum(CONTAINER_ACTIONS),
  status: ContainerStatusSchema.optional(),
}) satisfies z.ZodType<ContainerActionResponse>;
