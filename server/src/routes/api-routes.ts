import express, { Request, Response, RequestHandler } from "express";
import expressListEndpoints from "express-list-endpoints";
import { requirePermission } from "../middleware/auth";
import { getRouteMeta } from "../lib/openapi-registry";

const router = express.Router();

/**
 * GET /api/routes
 * Returns all registered API routes, generated at runtime via express-list-endpoints.
 * Routes registered via describeRoute() are enriched with summary, tags, side effects,
 * and required permission so the agent sidecar can pick the right tool without guessing.
 */
router.get(
  "/",
  requirePermission("agent:use") as RequestHandler,
  (req: Request, res: Response) => {
    const app = req.app;
    const endpoints = expressListEndpoints(app);

    endpoints.sort((a, b) => a.path.localeCompare(b.path));

    type EnrichedEndpoint = {
      path: string;
      methods: string[];
      middlewares: string[];
      meta?: {
        method: string;
        summary: string;
        description?: string;
        tags: string[];
        permission: string | string[];
        sideEffects: string;
      };
    };

    const enriched: EnrichedEndpoint[] = endpoints.map((endpoint) => {
      // express-list-endpoints returns one entry per path with all methods; surface
      // the first method's metadata, which is enough for the markdown lines below.
      const firstMethod = endpoint.methods[0];
      const meta = firstMethod
        ? getRouteMeta(firstMethod, endpoint.path)
        : undefined;
      return {
        path: endpoint.path,
        methods: endpoint.methods,
        middlewares: endpoint.middlewares,
        ...(meta && {
          meta: {
            method: meta.method,
            summary: meta.summary,
            description: meta.description,
            tags: meta.tags,
            permission: meta.permission,
            sideEffects: meta.sideEffects,
          },
        }),
      };
    });

    const groups = new Map<string, string[]>();

    for (const endpoint of enriched) {
      if (endpoint.methods.length === 0) continue;

      const segments = endpoint.path.split("/").filter(Boolean);
      let groupKey: string;
      if (segments[0] === "api" && segments.length >= 2) {
        groupKey = segments[1]
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      } else if (segments[0] === "auth") {
        groupKey = "Auth";
      } else {
        groupKey = segments[0]?.replace(/\b\w/g, (c) => c.toUpperCase()) || "Root";
      }

      const lines = groups.get(groupKey) || [];
      for (const method of endpoint.methods) {
        const meta = getRouteMeta(method, endpoint.path);
        if (meta) {
          const perm = Array.isArray(meta.permission)
            ? meta.permission.join(", ")
            : meta.permission;
          lines.push(`- ${method} ${endpoint.path}`);
          lines.push(`    Summary: ${meta.summary}`);
          lines.push(`    Permission: ${perm}`);
          lines.push(`    Side effects: ${meta.sideEffects}`);
        } else {
          lines.push(`- ${method} ${endpoint.path}`);
        }
      }
      groups.set(groupKey, lines);
    }

    let markdown = "## Available API Endpoints\n\n";
    for (const [group, lines] of groups) {
      markdown += `### ${group}\n`;
      markdown += lines.join("\n") + "\n\n";
    }

    res.json({
      success: true,
      data: {
        endpoints: enriched,
        markdown: markdown.trim(),
      },
    });
  },
);

export default router;
