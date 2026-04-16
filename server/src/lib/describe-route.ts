import type { RequestHandler, Router } from "express";
import type { ZodObject, ZodTypeAny } from "zod";
import type { PermissionScope } from "@mini-infra/types";
import type { ResponseConfig } from "@asteasolutions/zod-to-openapi";
import { requirePermission } from "./permission-middleware";
import {
  openApiRegistry,
  rememberRouteMeta,
  type RouteMeta,
} from "./openapi-registry";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type ResponseDescriptor =
  | ZodTypeAny
  | {
      contentType?: string;
      schema?: ZodTypeAny;
      description?: string;
    };

export type DescribeRouteMeta = {
  summary: string;
  description?: string;
  tags?: string[];
  permission: PermissionScope | PermissionScope[];
  sideEffects: string;
  request?: {
    body?: ZodTypeAny;
    // query/params must be ZodObject schemas per OpenAPI parameter semantics.
    query?: ZodObject;
    params?: ZodObject;
  };
  response?: ResponseDescriptor;
  errorResponses?: Array<{ status: number; description: string }>;
};

export type RouteDescriber = (
  method: HttpMethod,
  relativePath: string,
  meta: DescribeRouteMeta,
  ...handlers: RequestHandler[]
) => void;

function isZodSchema(value: ResponseDescriptor): value is ZodTypeAny {
  return typeof (value as { _def?: unknown })._def !== "undefined";
}

function joinPaths(prefix: string, relative: string): string {
  if (relative === "/" || relative === "") return prefix;
  return `${prefix.replace(/\/$/, "")}/${relative.replace(/^\//, "")}`;
}

function buildResponses(
  response: ResponseDescriptor | undefined,
  errorResponses: DescribeRouteMeta["errorResponses"],
): Record<string, ResponseConfig> {
  const responses: Record<string, ResponseConfig> = {};

  if (response) {
    if (isZodSchema(response)) {
      responses[200] = {
        description: "Success",
        content: { "application/json": { schema: response } },
      };
    } else {
      const contentType = response.contentType ?? "application/json";
      const description = response.description ?? "Success";
      // ZodMediaTypeObject requires a schema. For opaque binary responses we
      // describe the body via a noop schema so the content type still appears
      // in the spec without committing to a shape.
      const schema = response.schema ?? (undefined as unknown as ZodTypeAny);
      responses[200] = schema
        ? {
            description,
            content: { [contentType]: { schema } },
          }
        : {
            description,
          };
    }
  }

  for (const err of errorResponses ?? []) {
    responses[err.status] = { description: err.description };
  }

  return responses;
}

/**
 * Create a route describer bound to a router and its mount prefix.
 *
 * Each describe() call does three things:
 *   1. Register the route on the Express router with requirePermission injected.
 *   2. Register an OpenAPI path in the shared registry for /api/openapi.json.
 *   3. Remember a compact metadata record for /api/routes enrichment.
 *
 * The full (mounted) path is required by the OpenAPI spec, so pass the same
 * mount path used in app-factory's getRouteDefinitions().
 */
export function createRouteDescriber(
  router: Router,
  mountPath: string,
): RouteDescriber {
  return (method, relativePath, meta, ...handlers) => {
    const fullPath = joinPaths(mountPath, relativePath);

    const permissionMiddleware = requirePermission(
      meta.permission,
    ) as RequestHandler;

    router[method](relativePath, permissionMiddleware, ...handlers);

    const request = meta.request
      ? {
          ...(meta.request.params && { params: meta.request.params }),
          ...(meta.request.query && { query: meta.request.query }),
          ...(meta.request.body && {
            body: {
              content: {
                "application/json": { schema: meta.request.body },
              },
            },
          }),
        }
      : undefined;

    const permissionScopes = Array.isArray(meta.permission)
      ? meta.permission
      : [meta.permission];

    openApiRegistry.registerPath({
      method,
      path: fullPath,
      summary: meta.summary,
      description: meta.description,
      tags: meta.tags ?? [],
      security: [{ permission: permissionScopes }],
      ...(request && { request }),
      responses: buildResponses(meta.response, meta.errorResponses),
    });

    const record: RouteMeta = {
      method,
      path: fullPath,
      summary: meta.summary,
      description: meta.description,
      tags: meta.tags ?? [],
      permission: meta.permission,
      sideEffects: meta.sideEffects,
    };
    rememberRouteMeta(record);
  };
}
