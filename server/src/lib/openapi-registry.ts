import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import type { PermissionScope } from "@mini-infra/types";

extendZodWithOpenApi(z);

export const openApiRegistry = new OpenAPIRegistry();

export type RouteMeta = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  permission: PermissionScope | PermissionScope[];
  sideEffects: string;
};

const routeMetaByKey = new Map<string, RouteMeta>();

function metaKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function rememberRouteMeta(meta: RouteMeta): void {
  routeMetaByKey.set(metaKey(meta.method, meta.path), meta);
}

export function getRouteMeta(
  method: string,
  path: string,
): RouteMeta | undefined {
  return routeMetaByKey.get(metaKey(method, path));
}

export function listRouteMeta(): RouteMeta[] {
  return Array.from(routeMetaByKey.values());
}
